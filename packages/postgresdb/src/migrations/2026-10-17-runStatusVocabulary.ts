import { defineMigration, type MigrationContext } from '@ttoss/postgresdb';

/**
 * Every record that runs or settles answers in one vocabulary:
 * `queued → running → completed | failed | cancelled`.
 *
 * - `orchestration_runs.status`: `succeeded` → `completed`.
 * - `webhook_deliveries.status`: `pending` → `queued`, `success` → `completed`.
 * - `generations.status`: `in_progress` → `running`.
 * - `eval_runs.status`: `canceled` → `cancelled`.
 * - `formation_operations.status` and each recorded event's `status`,
 *   `playbook_executions.status`, `trigger_firings.status` and the target
 *   status its `result` recorded: `pending` → `queued`, `succeeded` →
 *   `completed`; `playbook_exports.status`: `succeeded` → `completed`.
 * - The event `orchestration_runs.succeeded` → `orchestration_runs.completed`
 *   wherever a subscription names it: `webhooks.events`,
 *   `triggers.event_pattern`, and the templates and last-applied properties a
 *   formation keeps, which a later deploy re-validates.
 *
 * The two enum columns keep their rows by renaming the label in place, so no
 * row is rewritten and the column default follows the label. `sync` only ever
 * adds an enum label, which would leave every stored row on the old word.
 */
const OLD_EVENT = 'orchestration_runs.succeeded';
const NEW_EVENT = 'orchestration_runs.completed';

type EnumRename = { table: string; from: string; to: string };

const ENUM_RENAMES: EnumRename[] = [
  { table: 'orchestration_runs', from: 'succeeded', to: 'completed' },
  { table: 'webhook_deliveries', from: 'pending', to: 'queued' },
  { table: 'webhook_deliveries', from: 'success', to: 'completed' },
];

type StringRename = { table: string; renames: Record<string, string> };

const STRING_RENAMES: StringRename[] = [
  { table: 'generations', renames: { in_progress: 'running' } },
  { table: 'eval_runs', renames: { canceled: 'cancelled' } },
  {
    table: 'formation_operations',
    renames: { pending: 'queued', succeeded: 'completed' },
  },
  {
    table: 'playbook_executions',
    renames: { pending: 'queued', succeeded: 'completed' },
  },
  { table: 'playbook_exports', renames: { succeeded: 'completed' } },
  {
    table: 'trigger_firings',
    renames: { pending: 'queued', succeeded: 'completed' },
  },
];

const DEFAULTS: Record<string, string> = {
  generations: 'running',
  formation_operations: 'queued',
};

const enumType = (table: string) => {
  return `enum_${table}_status`;
};

const labelExists = (args: { table: string; label: string }) => {
  return `EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = '${enumType(args.table)}' AND e.enumlabel = '${args.label}')`;
};

// A label `sync` already added beside the old one cannot be renamed into, so
// the rows move to it instead and the stale label stays, unused.
const enumRenameSql = (rename: EnumRename) => {
  const { table, from, to } = rename;
  return `
    DO $$ BEGIN
      IF ${labelExists({ table, label: from })} THEN
        IF ${labelExists({ table, label: to })} THEN
          UPDATE ${table} SET status = '${to}' WHERE status = '${from}';
        ELSE
          ALTER TYPE ${enumType(table)} RENAME VALUE '${from}' TO '${to}';
        END IF;
      END IF;
    END $$;`;
};

const stringRenameSql = (rename: StringRename) => {
  const cases = Object.entries(rename.renames)
    .map(([from, to]) => {
      return `WHEN '${from}' THEN '${to}'`;
    })
    .join(' ');
  const olds = Object.keys(rename.renames)
    .map((from) => {
      return `'${from}'`;
    })
    .join(', ');
  const setDefault = DEFAULTS[rename.table]
    ? `ALTER TABLE ${rename.table} ALTER COLUMN status SET DEFAULT '${DEFAULTS[rename.table]}';`
    : '';
  return `
    UPDATE ${rename.table} SET status = CASE status ${cases} END
     WHERE status IN (${olds});
    ${setDefault}`;
};

// Keyed `<table>.<column>`: each runs only where that column exists.
const JSON_SQL: Record<string, string> = {
  'formation_operations.events': `
    UPDATE formation_operations
       SET events = (
         SELECT jsonb_agg(CASE WHEN event->>'status' = 'succeeded'
           THEN jsonb_set(event, '{status}', '"completed"') ELSE event END
           ORDER BY ord)
           FROM jsonb_array_elements(events) WITH ORDINALITY AS e(event, ord))
     WHERE jsonb_typeof(events) = 'array'
       AND jsonb_path_exists(events, '$[*] ? (@.status == "succeeded")');`,
  'trigger_firings.result': `
    UPDATE trigger_firings
       SET result = jsonb_set(result, '{status}', '"completed"')
     WHERE result->>'status' = 'succeeded';`,
  'webhooks.events': `
    UPDATE webhooks SET events = array_replace(events, '${OLD_EVENT}', '${NEW_EVENT}')
     WHERE '${OLD_EVENT}' = ANY(events);`,
  'triggers.event_pattern': `
    UPDATE triggers SET event_pattern = '${NEW_EVENT}'
     WHERE event_pattern = '${OLD_EVENT}';`,
  'formations.template': `
    UPDATE formations
       SET template = replace(template::text, '"${OLD_EVENT}"', '"${NEW_EVENT}"')::jsonb
     WHERE template::text LIKE '%"${OLD_EVENT}"%';`,
  'formation_resources.last_applied_properties': `
    UPDATE formation_resources
       SET last_applied_properties = replace(
         last_applied_properties::text, '"${OLD_EVENT}"', '"${NEW_EVENT}"')::jsonb
     WHERE last_applied_properties::text LIKE '%"${OLD_EVENT}"%';`,
};

const PENDING_SQL: Record<string, string> = {
  // `events::jsonb`: `json` once `2026-11-01-payloads-keep-key-order` has run.
  'formation_operations.events': `SELECT 1 FROM formation_operations
    WHERE jsonb_typeof(events::jsonb) = 'array'
      AND jsonb_path_exists(events::jsonb, '$[*] ? (@.status == "succeeded")')`,
  'trigger_firings.result': `SELECT 1 FROM trigger_firings
    WHERE result->>'status' = 'succeeded'`,
  'webhooks.events': `SELECT 1 FROM webhooks WHERE '${OLD_EVENT}' = ANY(events)`,
  'triggers.event_pattern': `SELECT 1 FROM triggers WHERE event_pattern = '${OLD_EVENT}'`,
  'formations.template': `SELECT 1 FROM formations
    WHERE template::text LIKE '%"${OLD_EVENT}"%'`,
  'formation_resources.last_applied_properties': `SELECT 1 FROM formation_resources
    WHERE last_applied_properties::text LIKE '%"${OLD_EVENT}"%'`,
};

const pendingStatusSql = (args: { table: string; olds: string[] }) => {
  const list = args.olds
    .map((value) => {
      return `'${value}'`;
    })
    .join(', ');
  return `SELECT 1 FROM ${args.table} WHERE status::text IN (${list})`;
};

const hasColumn = async (args: { context: MigrationContext; key: string }) => {
  const [table, column] = args.key.split('.');
  return (
    (await args.context.tableExists({ table })) &&
    args.context.columnExists({ table, column })
  );
};

const hasStatus = (args: { context: MigrationContext; table: string }) => {
  return hasColumn({ context: args.context, key: `${args.table}.status` });
};

/** Every probe for the columns this database holds, one per pending change. */
const pendingProbes = async (context: MigrationContext) => {
  const probes: string[] = [];
  for (const rename of ENUM_RENAMES) {
    if (await hasStatus({ context, table: rename.table })) {
      probes.push(
        `SELECT 1 WHERE ${labelExists({ table: rename.table, label: rename.from })}
           AND NOT ${labelExists({ table: rename.table, label: rename.to })}`,
        pendingStatusSql({ table: rename.table, olds: [rename.from] })
      );
    }
  }
  for (const rename of STRING_RENAMES) {
    if (await hasStatus({ context, table: rename.table })) {
      probes.push(
        pendingStatusSql({
          table: rename.table,
          olds: Object.keys(rename.renames),
        })
      );
    }
  }
  for (const [key, sql] of Object.entries(PENDING_SQL)) {
    if (await hasColumn({ context, key })) probes.push(sql);
  }
  return probes;
};

export const runStatusVocabulary = defineMigration({
  name: '2026-10-17-run-status-vocabulary',
  description:
    'Run, attempt and delivery statuses in one vocabulary (queued, running, completed, failed, cancelled), and the orchestration_runs.completed event name wherever a subscription stores it.',
  isApplied: async (context) => {
    for (const sql of await pendingProbes(context)) {
      if ((await context.select({ sql: `${sql} LIMIT 1` })).length > 0) {
        return false;
      }
    }
    return true;
  },
  up: async (context) => {
    context.say('renaming run statuses to the shared vocabulary');
    const statements: string[] = [];
    for (const rename of ENUM_RENAMES) {
      if (await hasStatus({ context, table: rename.table })) {
        statements.push(enumRenameSql(rename));
      }
    }
    for (const rename of STRING_RENAMES) {
      if (await hasStatus({ context, table: rename.table })) {
        statements.push(stringRenameSql(rename));
      }
    }
    for (const [key, sql] of Object.entries(JSON_SQL)) {
      if (await hasColumn({ context, key })) statements.push(sql);
    }
    if (statements.length === 0) return;
    // One statement string, so no table is left half renamed.
    await context.run({ sql: statements.join('\n') });
  },
});
