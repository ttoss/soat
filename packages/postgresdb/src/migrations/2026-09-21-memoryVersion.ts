import { defineMigration } from '@ttoss/postgresdb';

/**
 * `memories.version` is the counter a write states a precondition against
 * (`lib/writePrecondition.ts`), the same shape `agents.version` and
 * `documents.version` use. A memory has no archived-config table alongside
 * it: retraction and supersession already answer "what happened to this
 * fact" through the assertion ledger, so the counter here exists only to
 * separate two writers racing on one memory, not to record its history.
 *
 * `sync` never alters an existing table, so the column is a migration. Every
 * existing memory is at version 1: nothing before this write has ever raced
 * on it.
 */
export const memoryVersion = defineMigration({
  name: '2026-09-21-memory-version',
  description:
    'memories.version counts concurrent writes, so PUT /memories/{id} can state a write precondition.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'memories' }))) return true;
    return context.columnExists({ table: 'memories', column: 'version' });
  },
  up: async (context) => {
    context.say('adding memories.version');
    await context.run({
      sql: `
        ALTER TABLE memories
          ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
      `,
    });
  },
});
