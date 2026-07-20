import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { QuotaWindow } from './quotas';
import {
  retryAfterSeconds,
  windowKeyFor,
  windowResetsAt,
  windowStartsAt,
} from './quotas';

const log = createDebug('soat:quotas');

type QuotaInstance = InstanceType<(typeof db)['Quota']>;

export type QuotaBreach = {
  quotaId: string;
  scope: string;
  scopeRef: string | null;
  metric: string;
  window: string;
  limit: number;
  resetsAt: Date;
  retryAfter: number;
};

// Specificity for attribution when several matching quotas breach at once. The
// most specific scope is reported: an entity-scoped cap (`agent`, `api_key`) is
// more specific than the project-wide cap. `requests` only ever produces
// `api_key`/`project`; `tokens`/`cost_usd` only ever produce `agent`/`project`.
const scopeRank = (scope: string): number => {
  if (scope === 'agent') return 3;
  if (scope === 'api_key') return 2;
  return 1;
};

/**
 * The `QUOTA_EXCEEDED` DomainError for a breach — the shared source of the 429
 * body across every enforcement point (the request middleware and the
 * token/cost generation gate). Error responses bypass the caseTransform
 * middleware, so meta keys are snake_case to match the external REST contract.
 */
export const quotaBreachError = (breach: QuotaBreach): DomainError => {
  return new DomainError(
    'QUOTA_EXCEEDED',
    `Quota exceeded for ${breach.scope}${
      breach.scopeRef ? ` ${breach.scopeRef}` : ''
    }.`,
    {
      quota_id: breach.quotaId,
      metric: breach.metric,
      limit: breach.limit,
      window: breach.window,
      resets_at: breach.resetsAt.toISOString(),
    }
  );
};

/**
 * Atomically increments (upserting on first hit) the counter for one
 * `(quota, window)` and returns the new count. A single statement is both the
 * increment and the check — no read-then-write race. Correct across replicas
 * because the composite primary key serializes conflicting upserts in Postgres.
 */
const incrementCounter = async (args: {
  quotaId: number;
  windowKey: string;
  now: Date;
}): Promise<number> => {
  // Postgres `sequelize.query` returns `[rows, metadata]`; the RETURNING clause
  // puts the new count in `rows`.
  const [rows] = await db.sequelize.query(
    `INSERT INTO "quota_window_counters" ("quota_id", "window_key", "count", "updated_at")
     VALUES (:quotaId, :windowKey, 1, :now)
     ON CONFLICT ("quota_id", "window_key")
     DO UPDATE SET "count" = "quota_window_counters"."count" + 1, "updated_at" = :now
     RETURNING "count"`,
    {
      replacements: {
        quotaId: args.quotaId,
        windowKey: args.windowKey,
        now: args.now,
      },
    }
  );

  // The upsert always returns exactly one row (the inserted or updated
  // counter), so `rows[0]` is guaranteed present.
  const returned = rows as Array<{ count: string | number }>;
  const count = Number(returned[0].count);

  // On the first hit of a new window, opportunistically garbage-collect this
  // quota's expired windows — fixed windows never count a stale key again.
  if (count === 1) {
    await db.sequelize.query(
      `DELETE FROM "quota_window_counters"
       WHERE "quota_id" = :quotaId AND "window_key" <> :windowKey`,
      {
        replacements: { quotaId: args.quotaId, windowKey: args.windowKey },
      }
    );
  }

  return count;
};

/**
 * Every request that reaches the middleware increments the counter of every
 * matching `enforce` quota — including requests that will be rejected. Returns
 * the most specific breached quota for attribution, or `null` when nothing
 * breached.
 *
 * Matching (`requests` metric): a `project`-scope quota applies to every key in
 * the project; an `api_key`-scope quota applies to all keys (null ref) or the
 * one named key. `monitor` quotas are a pass-through no-op in Phase 1, so only
 * `enforce` quotas are counted here.
 */
export const evaluateRequestQuotas = async (args: {
  projectId: number;
  apiKeyPublicId: string;
}): Promise<QuotaBreach | null> => {
  const now = new Date();

  const quotas = (await db.Quota.findAll({
    where: {
      projectId: args.projectId,
      metric: 'requests',
      mode: 'enforce',
    },
  })) as QuotaInstance[];

  const matching = quotas.filter((quota) => {
    if (quota.scope === 'project') return quota.scopeRef == null;
    if (quota.scope === 'api_key') {
      return quota.scopeRef == null || quota.scopeRef === args.apiKeyPublicId;
    }
    return false; // agent scope never matches the requests metric
  });

  if (matching.length === 0) return null;

  const breaches: QuotaBreach[] = [];

  for (const quota of matching) {
    const window = quota.window as QuotaWindow;
    const windowKey = windowKeyFor({ window, now });
    const count = await incrementCounter({
      quotaId: (quota as unknown as { id: number }).id,
      windowKey,
      now,
    });

    const limit = Number(quota.limit);
    if (count > limit) {
      const resetsAt = windowResetsAt({ window, now });
      breaches.push({
        quotaId: quota.publicId,
        scope: quota.scope,
        scopeRef: quota.scopeRef,
        metric: quota.metric,
        window: quota.window,
        limit,
        resetsAt,
        retryAfter: retryAfterSeconds({ resetsAt, now }),
      });
    }
  }

  if (breaches.length === 0) return null;

  breaches.sort((a, b) => {
    return scopeRank(b.scope) - scopeRank(a.scope);
  });

  const breach = breaches[0];
  log(
    'evaluateRequestQuotas: breach quota=%s scope=%s limit=%d',
    breach.quotaId,
    breach.scope,
    breach.limit
  );
  return breach;
};

// ── Token / cost pre-generation check (Phase 2) ──────────────────────────────

// Tokens are measured in this unit; a `tokens` quota sums the billable
// token-unit component quantities (uncached input + output + cached), excluding
// the non-billable `reasoning_tokens` detail so it is never double counted.
const TOKEN_UNIT = 'token';

/**
 * Sums a `tokens` / `cost_usd` metric over the current fixed window from
 * `UsageEvent` (and its component rows for tokens). Optionally scoped to one
 * agent. Aggregating the meter at check time — rather than keeping a separate
 * counter — is what keeps quotas and metering from ever disagreeing.
 */
const aggregateGenerationMetric = async (args: {
  metric: 'tokens' | 'cost_usd';
  projectId: number;
  agentId: number | null;
  windowStart: Date;
}): Promise<number> => {
  const where: Record<string | symbol, unknown> = {
    projectId: args.projectId,
    createdAt: { [Op.gte]: args.windowStart },
  };
  if (args.agentId != null) where.agentId = args.agentId;

  if (args.metric === 'cost_usd') {
    const events = await db.UsageEvent.findAll({
      where,
      attributes: ['costUsd'],
    });
    return events.reduce((sum, event) => {
      return sum + Number(event.costUsd ?? 0);
    }, 0);
  }

  const events = await db.UsageEvent.findAll({
    where,
    attributes: ['id'],
    include: [
      {
        model: db.UsageComponent,
        as: 'components',
        attributes: ['quantity', 'unit', 'billable'],
      },
    ],
  });
  return events.reduce((sum, event) => {
    const components = event.components ?? [];
    return (
      sum +
      components.reduce((componentSum, component) => {
        const counts = component.unit === TOKEN_UNIT && component.billable;
        return componentSum + (counts ? Number(component.quantity) : 0);
      }, 0)
    );
  }, 0);
};

/**
 * The pre-generation token/cost check. Before a generation starts, the current
 * window aggregate for every matching `enforce` `tokens`/`cost_usd` quota is
 * compared to its limit; a breach (aggregate at or over the limit) returns the
 * most specific breached quota so the caller can block the *new* generation
 * with `QUOTA_EXCEEDED`. In-flight generations are never inspected — their
 * tokens are already spent — so a budget may overshoot by at most one
 * generation.
 *
 * Matching: a `project`-scope quota (null ref) aggregates the whole project; an
 * `agent`-scope quota with this agent's ref aggregates only that agent, and
 * with a null ref aggregates the whole project. `api_key`-scope token/cost
 * quotas are never aggregated (usage events carry no api-key attribution, and
 * the create-time validation rejects the combination) — skipped defensively.
 */
export const evaluateGenerationQuotas = async (args: {
  agentId: string;
  projectIds?: number[];
}): Promise<QuotaBreach | null> => {
  const now = new Date();

  const agentWhere: Record<string, unknown> = { publicId: args.agentId };
  if (args.projectIds !== undefined) agentWhere.projectId = args.projectIds;
  const agent = await db.Agent.findOne({
    where: agentWhere,
    attributes: ['id', 'projectId', 'publicId'],
  });
  if (!agent) return null;

  const agentInternalId = agent.id;
  const projectId = agent.projectId;
  const agentPublicId = agent.publicId;

  const quotas = (await db.Quota.findAll({
    where: {
      projectId,
      metric: ['tokens', 'cost_usd'],
      mode: 'enforce',
    },
  })) as QuotaInstance[];

  const matching = quotas.filter((quota) => {
    if (quota.scope === 'project') return quota.scopeRef == null;
    if (quota.scope === 'agent') {
      return quota.scopeRef == null || quota.scopeRef === agentPublicId;
    }
    return false; // api_key token/cost is never aggregatable
  });

  if (matching.length === 0) return null;

  const breaches: QuotaBreach[] = [];

  for (const quota of matching) {
    const window = quota.window as QuotaWindow;
    const scopeToAgent = quota.scope === 'agent' && quota.scopeRef != null;
    const total = await aggregateGenerationMetric({
      metric: quota.metric as 'tokens' | 'cost_usd',
      projectId,
      agentId: scopeToAgent ? agentInternalId : null,
      windowStart: windowStartsAt({ window, now }),
    });

    const limit = Number(quota.limit);
    if (total >= limit) {
      const resetsAt = windowResetsAt({ window, now });
      breaches.push({
        quotaId: quota.publicId,
        scope: quota.scope,
        scopeRef: quota.scopeRef,
        metric: quota.metric,
        window: quota.window,
        limit,
        resetsAt,
        retryAfter: retryAfterSeconds({ resetsAt, now }),
      });
    }
  }

  if (breaches.length === 0) return null;

  breaches.sort((a, b) => {
    return scopeRank(b.scope) - scopeRank(a.scope);
  });

  const breach = breaches[0];
  log(
    'evaluateGenerationQuotas: breach quota=%s scope=%s metric=%s limit=%d',
    breach.quotaId,
    breach.scope,
    breach.metric,
    breach.limit
  );
  return breach;
};
