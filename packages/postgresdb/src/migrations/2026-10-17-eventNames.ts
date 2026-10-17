import { defineMigration, type MigrationContext } from '@ttoss/postgresdb';

/**
 * Every platform event is named `<resource type, plural>.<verb>`, so a
 * `<namespace>.*` pattern is exactly one resource's events. Each stored
 * subscription is rewritten to the new names: `webhooks.events`,
 * `triggers.event_pattern`, `memory_rules.on`, and the templates and
 * last-applied properties a formation keeps, which a later deploy re-validates.
 *
 * A namespace pattern whose events all moved (`eval_run.*`) moves with them. A
 * pattern on a namespace that keeps events of its own (`agents.*`) is left as
 * written: it still names that resource's events.
 */
const RENAMES: Record<string, string> = {
  'agents.generation.completed': 'generations.completed',
  'agents.generation.failed': 'generations.failed',
  'agents.generation.requires_action': 'generations.requires_action',
  'agents.generation.*': 'generations.*',
  'sessions.generation.completed': 'generations.completed',
  'sessions.generation.requires_action': 'generations.requires_action',
  'sessions.generation.started': 'sessions.generation_started',
  'sessions.generation.*': 'generations.*',
  'eval_run.completed': 'eval_runs.completed',
  'eval_run.failed': 'eval_runs.failed',
  'eval_run.*': 'eval_runs.*',
  'quota.exceeded': 'quotas.exceeded',
  'quota.*': 'quotas.*',
  'guardrail.tripwire': 'guardrails.tripwire',
  'guardrail.*': 'guardrails.*',
  'audit.entry_created': 'audit_entries.created',
  'audit.*': 'audit_entries.*',
  'conversations.message.created': 'conversation_messages.created',
  'conversations.message.generated': 'conversation_messages.generated',
  'conversations.message.deleted': 'conversation_messages.deleted',
  'conversations.message.*': 'conversation_messages.*',
  'usage.threshold_crossed': 'usage_thresholds.crossed',
  'usage.*': 'usage_thresholds.*',
};

const OLD_NAMES = Object.keys(RENAMES);

const literal = (value: string) => {
  return `'${value}'`;
};

const MAPPING = `(VALUES ${Object.entries(RENAMES)
  .map(([from, to]) => {
    return `(${literal(from)}, ${literal(to)})`;
  })
  .join(', ')}) AS m(old_name, new_name)`;

const OLD_LIST = `ARRAY[${OLD_NAMES.map(literal).join(', ')}]::text[]`;

// Matched as JSON strings, quotes included, so a name is never rewritten
// inside a longer one.
const jsonHoldsOldName = (expression: string) => {
  return OLD_NAMES.map((name) => {
    return `strpos(${expression}::text, '"${name}"') > 0`;
  }).join(' OR ');
};

const jsonRenamed = (expression: string) => {
  return Object.entries(RENAMES).reduce((sql, [from, to]) => {
    return `replace(${sql}, '"${from}"', '"${to}"')`;
  }, `${expression}::text`);
};

const jsonUpdate = (args: { table: string; column: string }) => {
  return `
    UPDATE ${args.table} SET ${args.column} = ${jsonRenamed(args.column)}::jsonb
     WHERE ${jsonHoldsOldName(args.column)};`;
};

const scalarUpdate = (args: { table: string; column: string }) => {
  return `
    UPDATE ${args.table} t SET ${args.column} = m.new_name FROM ${MAPPING}
     WHERE t.${args.column} = m.old_name;`;
};

// Keyed `<table>.<column>`: each runs only where that column exists.
const UPDATE_SQL: Record<string, string> = {
  // Two old names can land on one new name; the array keeps it once, where it
  // first appeared.
  'webhooks.events': `
    UPDATE webhooks w
       SET events = (
         SELECT array_agg(s.name ORDER BY s.first)
           FROM (SELECT COALESCE(m.new_name, e.name) AS name, min(e.ord) AS first
                   FROM unnest(w.events) WITH ORDINALITY AS e(name, ord)
                   LEFT JOIN ${MAPPING} ON m.old_name = e.name
                  GROUP BY 1) s)
     WHERE w.events::text[] && ${OLD_LIST};`,
  'triggers.event_pattern': scalarUpdate({
    table: 'triggers',
    column: 'event_pattern',
  }),
  'memory_rules.on': scalarUpdate({ table: 'memory_rules', column: '"on"' }),
  'formations.template': jsonUpdate({
    table: 'formations',
    column: 'template',
  }),
  'formation_resources.last_applied_properties': jsonUpdate({
    table: 'formation_resources',
    column: 'last_applied_properties',
  }),
};

const PENDING_SQL: Record<string, string> = {
  'webhooks.events': `SELECT 1 FROM webhooks WHERE events::text[] && ${OLD_LIST}`,
  'triggers.event_pattern': `SELECT 1 FROM triggers
    WHERE event_pattern = ANY(${OLD_LIST})`,
  'memory_rules.on': `SELECT 1 FROM memory_rules WHERE "on" = ANY(${OLD_LIST})`,
  'formations.template': `SELECT 1 FROM formations
    WHERE ${jsonHoldsOldName('template')}`,
  'formation_resources.last_applied_properties': `SELECT 1 FROM formation_resources
    WHERE ${jsonHoldsOldName('last_applied_properties')}`,
};

const hasColumn = async (args: { context: MigrationContext; key: string }) => {
  const [table, column] = args.key.split('.');
  return (
    (await args.context.tableExists({ table })) &&
    args.context.columnExists({ table, column })
  );
};

const presentKeys = async (context: MigrationContext) => {
  const keys: string[] = [];
  for (const key of Object.keys(UPDATE_SQL)) {
    if (await hasColumn({ context, key })) keys.push(key);
  }
  return keys;
};

export const eventNames = defineMigration({
  name: '2026-10-17-event-names',
  description:
    'Event names as <resource type, plural>.<verb> wherever a subscription stores one: webhook events, trigger patterns, memory rule bindings and stored formation templates.',
  isApplied: async (context) => {
    for (const key of await presentKeys(context)) {
      const rows = await context.select({ sql: `${PENDING_SQL[key]} LIMIT 1` });
      if (rows.length > 0) return false;
    }
    return true;
  },
  up: async (context) => {
    context.say('renaming stored event names and patterns');
    const statements = (await presentKeys(context)).map((key) => {
      return UPDATE_SQL[key];
    });
    if (statements.length === 0) return;
    // One statement string, so no subscription is left half renamed.
    await context.run({ sql: statements.join('\n') });
  },
});
