import { db } from '../db';
import {
  asSqlRow,
  readSqlCount,
  readSqlDecimal,
  readSqlNullableText,
  readSqlText,
} from './sqlRow';

// `day` buckets on the UTC calendar day; the rest on the matching column. Work
// with no end user behind it collapses into the `null` bucket rather than being
// dropped, so the groups still sum to the project total.
export const USAGE_GROUP_BY = [
  'model',
  'ai_provider',
  'agent',
  'run',
  'day',
  'meter_type',
  'actor',
  'session',
  'source',
] as const;

export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number];

/** One `(component, unit)` sum for a bucket, as Postgres returned it. */
export type ComponentSum = {
  component: string;
  unit: string;
  quantity: string;
  costUsd: string | null;
};

/** One bucket of the requested page, before it is shaped for the wire. */
export type GroupRow = {
  key: string | null;
  aiProviderId: string | null;
  costUsd: string | null;
  eventCount: number;
};

// Physical table names (the models are `underscored`), used by the aggregates
// below — they group in SQL rather than folding rows in JS, so the endpoint's
// cost tracks the number of buckets it answers with, not the number of events
// behind them.
const EVENT_TABLE = 'usage_events';
const COMPONENT_TABLE = 'usage_components';

/**
 * How each dimension is bucketed in SQL.
 *
 * `keyExpr` is the grouped expression, `join` the single association it needs
 * (against the six the row-by-row rollup used to hydrate for every event). The
 * `model` dimension is the only one that also reports a provider — see
 * `providerExpr` below.
 */
type GroupDimension = {
  keyExpr: string;
  join?: { table: string; alias: string; foreignKey: string };
};

// Exhaustive over `UsageGroupBy`, so a new dimension without a bucketing rule
// is a type error rather than a silent `null` bucket.
const GROUP_DIMENSIONS: { [K in UsageGroupBy]: GroupDimension } = {
  model: { keyExpr: 'e."model"' },
  meter_type: { keyExpr: 'e."meter_type"' },
  // What the spend was incurred *for*: `eval` / `eval_judge` mark verification
  // spend, so it can be priced apart from the traffic serving real users.
  // Ordinary traffic carries no source and buckets under the single null key.
  source: { keyExpr: 'e."source"' },
  // The provider instance the spend was billed against — a routed generation's
  // serving target, or the agent's pinned provider.
  ai_provider: {
    keyExpr: 'prov."public_id"',
    join: {
      table: 'ai_providers',
      alias: 'prov',
      foreignKey: 'ai_provider_id',
    },
  },
  agent: {
    keyExpr: 'agt."public_id"',
    join: { table: 'agents', alias: 'agt', foreignKey: 'agent_id' },
  },
  run: {
    keyExpr: 'run."public_id"',
    join: {
      table: 'orchestration_runs',
      alias: 'run',
      foreignKey: 'orchestration_run_id',
    },
  },
  actor: {
    keyExpr: 'act."public_id"',
    join: { table: 'actors', alias: 'act', foreignKey: 'actor_id' },
  },
  session: {
    keyExpr: 'sess."public_id"',
    join: { table: 'sessions', alias: 'sess', foreignKey: 'session_id' },
  },
  // Immutable events carry only created_at; bucket on its UTC calendar day.
  // `to_char` on the UTC-shifted timestamp keeps the key a `YYYY-MM-DD` string
  // regardless of the server's own timezone.
  day: {
    keyExpr: `to_char(e."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
  },
};

/**
 * The provider whose model the bucket names, under `group_by=model` only.
 *
 * A model id does not identify the model on its own: one project can hold two
 * providers serving byte-identical strings (a resold model and a tenant's own
 * credential for the same vendor), and a consumer that presents its own model
 * names cannot translate a bucket it cannot attribute. So the model dimension
 * buckets on (model, ai_provider_id) — `key` keeps its shape and this sibling
 * names the provider, instead of one merged bucket whose provider is
 * unanswerable. Events with no provider (a compute or storage meter) keep
 * collapsing into a single null-provider bucket.
 */
const MODEL_PROVIDER_JOIN = {
  table: 'ai_providers',
  alias: 'mprov',
  foreignKey: 'ai_provider_id',
};

// The joins one dimension needs: its own, plus the provider sibling the `model`
// dimension reports. `ai_provider` already joins the same table under its own
// alias, so the two are never emitted together.
const joinsFor = (
  groupBy: UsageGroupBy
): Array<{ table: string; alias: string; foreignKey: string }> => {
  const dimension = GROUP_DIMENSIONS[groupBy];
  const joins = dimension.join ? [dimension.join] : [];
  return groupBy === 'model' ? [...joins, MODEL_PROVIDER_JOIN] : joins;
};

const providerExpr = (groupBy: UsageGroupBy): string => {
  return groupBy === 'model'
    ? `${MODEL_PROVIDER_JOIN.alias}."public_id"`
    : 'NULL';
};

const joinClause = (groupBy: UsageGroupBy): string => {
  return joinsFor(groupBy)
    .map((join) => {
      return `LEFT JOIN "${join.table}" ${join.alias} ON ${join.alias}."id" = e."${join.foreignKey}"`;
    })
    .join('\n       ');
};

export type EventFilter = {
  projectId: number;
  from: Date | null;
  to: Date | null;
  meterType?: string;
};

// The `[from, to]` window and optional meter narrowing, as a WHERE fragment
// plus the replacements it names. `meterType` is deliberately unvalidated — a
// free-form column the meters listing filters the same way, so an unknown type
// yields an empty rollup rather than a 400.
const eventFilter = (
  filter: EventFilter
): { sql: string; replacements: Record<string, Date | number | string> } => {
  const clauses = ['e."project_id" = :projectId'];
  const replacements: Record<string, Date | number | string> = {
    projectId: filter.projectId,
  };

  if (filter.from) {
    clauses.push('e."created_at" >= :from');
    replacements.from = filter.from;
  }
  if (filter.to) {
    clauses.push('e."created_at" <= :to');
    replacements.to = filter.to;
  }
  if (filter.meterType !== undefined) {
    clauses.push('e."meter_type" = :meterType');
    replacements.meterType = filter.meterType;
  }

  return { sql: clauses.join(' AND '), replacements };
};

// A bucket is (key, provider), and either half may be null — `JSON.stringify`
// keeps the pair distinguishable where a concatenation would not.
export const bucketKeyOf = (args: {
  key: string | null;
  aiProviderId: string | null;
}): string => {
  return JSON.stringify([args.key, args.aiProviderId]);
};

const runQuery = async (args: {
  sql: string;
  replacements: Record<string, unknown>;
}): Promise<Array<Record<string, unknown>>> => {
  const [rows] = await db.sequelize.query(args.sql, {
    replacements: args.replacements,
  });
  return rows.map(asSqlRow);
};

/** The window's event count and summed event cost — no dimension, no joins. */
export const loadWindowTotals = async (
  filter: EventFilter
): Promise<{ costUsd: string | null; eventCount: number }> => {
  const where = eventFilter(filter);
  const rows = await runQuery({
    sql: `SELECT COUNT(*) AS event_count, SUM(e."cost_usd") AS cost_usd
            FROM "${EVENT_TABLE}" e
           WHERE ${where.sql}`,
    replacements: where.replacements,
  });
  const row = rows[0];
  if (!row) return { costUsd: null, eventCount: 0 };
  return {
    costUsd: readSqlDecimal(row, 'cost_usd'),
    eventCount: readSqlCount(row, 'event_count'),
  };
};

/** Every `(component, unit)` measured in the window, summed exactly by Postgres. */
export const loadWindowComponents = async (
  filter: EventFilter
): Promise<ComponentSum[]> => {
  const where = eventFilter(filter);
  const rows = await runQuery({
    sql: `SELECT c."component" AS component,
                 c."unit" AS unit,
                 SUM(c."quantity") AS quantity,
                 SUM(c."cost_usd") AS cost_usd
            FROM "${COMPONENT_TABLE}" c
            JOIN "${EVENT_TABLE}" e ON e."id" = c."usage_event_id"
           WHERE ${where.sql}
           GROUP BY c."component", c."unit"`,
    replacements: where.replacements,
  });
  return rows.map((row) => {
    return {
      component: readSqlText(row, 'component'),
      unit: readSqlText(row, 'unit'),
      quantity: readSqlDecimal(row, 'quantity') ?? '0',
      costUsd: readSqlDecimal(row, 'cost_usd'),
    };
  });
};

/**
 * The number of distinct buckets in the window — `groups.total`, and the figure
 * a "how many runs this cycle" question reads without walking a single page.
 */
export const countGroups = async (args: {
  filter: EventFilter;
  groupBy: UsageGroupBy;
}): Promise<number> => {
  const where = eventFilter(args.filter);
  const dimension = GROUP_DIMENSIONS[args.groupBy];
  const rows = await runQuery({
    sql: `SELECT COUNT(*) AS group_count
            FROM (SELECT ${dimension.keyExpr} AS group_key,
                         ${providerExpr(args.groupBy)} AS ai_provider_id
                    FROM "${EVENT_TABLE}" e
                    ${joinClause(args.groupBy)}
                   WHERE ${where.sql}
                   GROUP BY 1, 2) buckets`,
    replacements: where.replacements,
  });
  const row = rows[0];
  return row ? readSqlCount(row, 'group_count') : 0;
};

/**
 * The page's buckets, as a CTE both the page query and its component query
 * select from.
 *
 * Ordered biggest spender first, because that is the page a "what is this
 * costing" question wants to land on. `cost_usd` alone is not a total order —
 * a tie, or a window nothing priced, would let the database choose and let a
 * bucket repeat or vanish across pages — so the key and its provider break it.
 * Nulls sort last throughout: an unpriced bucket is not the top spender, and a
 * dimension that does not apply is not the first bucket to read.
 */
const PAGE_CTE = (groupBy: UsageGroupBy, where: string): string => {
  return `page AS (
            SELECT ${GROUP_DIMENSIONS[groupBy].keyExpr} AS group_key,
                   ${providerExpr(groupBy)} AS ai_provider_id,
                   COUNT(*) AS event_count,
                   SUM(e."cost_usd") AS cost_usd
              FROM "${EVENT_TABLE}" e
              ${joinClause(groupBy)}
             WHERE ${where}
             GROUP BY 1, 2
             ORDER BY 4 DESC NULLS LAST, 1 ASC NULLS LAST, 2 ASC NULLS LAST
             LIMIT :limit OFFSET :offset
          )`;
};

export const loadGroupPage = async (args: {
  filter: EventFilter;
  groupBy: UsageGroupBy;
  limit: number;
  offset: number;
}): Promise<GroupRow[]> => {
  const where = eventFilter(args.filter);
  const rows = await runQuery({
    sql: `WITH ${PAGE_CTE(args.groupBy, where.sql)}
          SELECT group_key, ai_provider_id, event_count, cost_usd FROM page`,
    replacements: {
      ...where.replacements,
      limit: args.limit,
      offset: args.offset,
    },
  });
  return rows.map((row) => {
    return {
      key: readSqlNullableText(row, 'group_key'),
      aiProviderId: readSqlNullableText(row, 'ai_provider_id'),
      costUsd: readSqlDecimal(row, 'cost_usd'),
      eventCount: readSqlCount(row, 'event_count'),
    };
  });
};

/**
 * Component sums for the page's buckets only.
 *
 * The bucket a component belongs to is its event's, so the events are re-keyed
 * and joined back to the page. `IS NOT DISTINCT FROM` rather than `=`: a null
 * key is a real bucket here (work with no run, no actor, no source behind it),
 * and `=` would drop exactly those rows.
 */
export const loadPageComponents = async (args: {
  filter: EventFilter;
  groupBy: UsageGroupBy;
  limit: number;
  offset: number;
}): Promise<Map<string, ComponentSum[]>> => {
  const where = eventFilter(args.filter);
  const rows = await runQuery({
    sql: `WITH ${PAGE_CTE(args.groupBy, where.sql)},
               keyed AS (
                 SELECT e."id" AS event_id,
                        ${GROUP_DIMENSIONS[args.groupBy].keyExpr} AS group_key,
                        ${providerExpr(args.groupBy)} AS ai_provider_id
                   FROM "${EVENT_TABLE}" e
                   ${joinClause(args.groupBy)}
                  WHERE ${where.sql}
               )
          SELECT keyed.group_key AS group_key,
                 keyed.ai_provider_id AS ai_provider_id,
                 c."component" AS component,
                 c."unit" AS unit,
                 SUM(c."quantity") AS quantity,
                 SUM(c."cost_usd") AS cost_usd
            FROM keyed
            JOIN page ON page.group_key IS NOT DISTINCT FROM keyed.group_key
                     AND page.ai_provider_id IS NOT DISTINCT FROM keyed.ai_provider_id
            JOIN "${COMPONENT_TABLE}" c ON c."usage_event_id" = keyed.event_id
           GROUP BY 1, 2, 3, 4`,
    replacements: {
      ...where.replacements,
      limit: args.limit,
      offset: args.offset,
    },
  });

  const byBucket = new Map<string, ComponentSum[]>();
  for (const row of rows) {
    const bucketKey = bucketKeyOf({
      key: readSqlNullableText(row, 'group_key'),
      aiProviderId: readSqlNullableText(row, 'ai_provider_id'),
    });
    const sums = byBucket.get(bucketKey) ?? [];
    sums.push({
      component: readSqlText(row, 'component'),
      unit: readSqlText(row, 'unit'),
      quantity: readSqlDecimal(row, 'quantity') ?? '0',
      costUsd: readSqlDecimal(row, 'cost_usd'),
    });
    byBucket.set(bucketKey, sums);
  }
  return byBucket;
};
