import { defineMigration } from '@ttoss/postgresdb';

/**
 * `usage_events.generation_public_id` keeps a metered generation counted after
 * the generation row is deleted: `generation_id` is `SET NULL`, the string is
 * not.
 *
 * The backfill copies the id from every generation that still exists. For one
 * already deleted, a standalone generation's event keys its idempotency on the
 * generation public id (`gen_…`, `gen_…:step:N`), so the id is read back from
 * the key; an orchestration node's key names the run instead and stays null.
 *
 * One statement string, so the column never lands without its backfill: the
 * probe reads the column, and a half-applied run would be recorded as done.
 */
const UP_SQL = `
  ALTER TABLE usage_events
    ADD COLUMN IF NOT EXISTS generation_public_id varchar(32);
  UPDATE usage_events e
     SET generation_public_id = g.public_id
    FROM generations g
   WHERE e.generation_id = g.id
     AND e.generation_public_id IS NULL;
  UPDATE usage_events
     SET generation_public_id = substring(idempotency_key from '^(gen_[A-Za-z0-9]{16})(:step:[0-9]+)?$')
   WHERE generation_id IS NULL
     AND generation_public_id IS NULL
     AND meter_type = 'llm_tokens'
     AND idempotency_key ~ '^gen_[A-Za-z0-9]{16}(:step:[0-9]+)?$';
`;

export const usageEventGenerationPublicId = defineMigration({
  name: '2026-09-25-usage-event-generation-public-id',
  description:
    'usage_events.generation_public_id, a durable copy of the generation public id that totals.distinct.generations counts over.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'usage_events' }))) return true;
    return context.columnExists({
      table: 'usage_events',
      column: 'generation_public_id',
    });
  },
  up: async (context) => {
    context.say('adding and backfilling usage_events.generation_public_id');
    await context.run({ sql: UP_SQL });
  },
});
