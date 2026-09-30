import { defineMigration } from '@ttoss/postgresdb';

/**
 * `usage_events.publisher_project_id` and its durable public id: the project
 * that owns a resource another project called through a share. `SET NULL` on
 * delete, like every attribution column, with the public id kept beside it.
 *
 * No backfill: no event predating shares crossed a project.
 *
 * One statement string, so the columns never land without their index: the
 * probe reads the columns, and a half-applied run would be recorded as done.
 */
const UP_SQL = `
  ALTER TABLE usage_events
    ADD COLUMN IF NOT EXISTS publisher_project_id integer
      REFERENCES projects (id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS publisher_project_public_id varchar(32);
  CREATE INDEX IF NOT EXISTS usage_events_publisher_project_id_idx
    ON usage_events (publisher_project_id);
`;

export const usageEventPublisherProject = defineMigration({
  name: '2026-09-30-usage-event-publisher-project',
  description:
    'usage_events.publisher_project_id, the project that owns a resource called through a share.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'usage_events' }))) return true;
    return (
      (await context.columnExists({
        table: 'usage_events',
        column: 'publisher_project_id',
      })) &&
      (await context.columnExists({
        table: 'usage_events',
        column: 'publisher_project_public_id',
      }))
    );
  },
  up: async (context) => {
    context.say('adding usage_events.publisher_project_id');
    await context.run({ sql: UP_SQL });
  },
});
