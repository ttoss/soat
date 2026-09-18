import { defineMigration } from '@ttoss/postgresdb';

/**
 * `activity_entries.generation_id` becomes a column, so the feed can be
 * filtered by the generation that produced an entry.
 *
 * `sync` creates missing tables and never alters one that exists, so the column
 * is a migration; the backfill moves the value out of `detail` rather than
 * copying it, because a fact stored twice is a fact that can disagree with
 * itself.
 */
const BACKFILL_SQL = `
  UPDATE activity_entries
     SET generation_id = detail ->> 'generationId',
         detail = detail - 'generationId'
   WHERE detail ? 'generationId';
`;

export const activityEntryGenerationId = defineMigration({
  name: '2026-09-18-activity-entry-generation-id',
  description:
    'activity_entries.generation_id is promoted from the detail blob to an indexed column so the feed can be filtered by generation.',
  /**
   * Every probe runs before any `up`, so this answers for the database as it
   * stands. A database with no `activity_entries` at all is one `sync` will
   * build from the models, and migrations run before that sync — the column
   * arrives with the table, so this records rather than replays.
   */
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'activity_entries' }))) {
      return true;
    }
    return context.columnExists({
      table: 'activity_entries',
      column: 'generation_id',
    });
  },
  up: async (context) => {
    context.say('adding activity_entries.generation_id');
    await context.addColumnIfMissing({
      table: 'activity_entries',
      column: 'generation_id',
      type: 'varchar(32)',
    });
    context.say('moving generationId out of activity_entries.detail');
    await context.run({ sql: BACKFILL_SQL });
    // The models' indexes over the new column are built by the sync, which
    // needs the column to exist first.
    await context.sync();
  },
});
