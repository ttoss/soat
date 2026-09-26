import { defineMigration } from '@ttoss/postgresdb';

/**
 * A public id beside every attribution FK on `usage_events` still counted by
 * FK, so `totals.distinct` keeps a deleted entity: the FKs are `SET NULL`, the
 * strings are not.
 *
 * The backfill copies each id from the row the FK still points at. An entity
 * already deleted left a null FK and nothing on the event that names it, so
 * that column stays null.
 */
const PAIRS = [
  { column: 'orchestration_run_id', table: 'orchestration_runs' },
  { column: 'agent_id', table: 'agents' },
  { column: 'actor_id', table: 'actors' },
  { column: 'session_id', table: 'sessions' },
  { column: 'trace_id', table: 'traces' },
  { column: 'ai_provider_id', table: 'ai_providers' },
  { column: 'tool_id', table: 'tools' },
] as const;

const publicIdColumn = (column: string) => {
  return column.replace(/_id$/, '_public_id');
};

/**
 * One statement string, so the columns never land without their backfill: the
 * probe reads the columns, and a half-applied run would be recorded as done.
 * One `UPDATE` pass rather than one per column, over the largest table.
 */
const UP_SQL = [
  ...PAIRS.map(({ column }) => {
    return `ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS ${publicIdColumn(column)} varchar(32);`;
  }),
  `UPDATE usage_events e SET ${PAIRS.map(({ column, table }) => {
    return `${publicIdColumn(column)} = COALESCE(e.${publicIdColumn(column)}, (SELECT public_id FROM ${table} WHERE id = e.${column}))`;
  }).join(', ')} WHERE ${PAIRS.map(({ column }) => {
    return `e.${column} IS NOT NULL`;
  }).join(' OR ')};`,
].join('\n');

export const usageEventDurablePublicIds = defineMigration({
  name: '2026-09-26-usage-event-durable-public-ids',
  description:
    'usage_events gains a public id beside each attribution FK, which totals.distinct counts so a deleted entity stays counted.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'usage_events' }))) return true;
    for (const { column } of PAIRS) {
      const exists = await context.columnExists({
        table: 'usage_events',
        column: publicIdColumn(column),
      });
      if (!exists) return false;
    }
    return true;
  },
  up: async (context) => {
    context.say('adding and backfilling the usage_events public id columns');
    await context.run({ sql: UP_SQL });
  },
});
