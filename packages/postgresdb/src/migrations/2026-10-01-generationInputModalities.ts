import { defineMigration } from '@ttoss/postgresdb';

/**
 * `generations.input_modalities`, the part types a turn's input carried.
 * Nullable, no backfill: a turn recorded before it reads as unknown.
 */
export const generationInputModalities = defineMigration({
  name: '2026-10-01-generation-input-modalities',
  description:
    "generations.input_modalities, the part types a turn's input carried.",
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'generations' }))) return true;
    return context.columnExists({
      table: 'generations',
      column: 'input_modalities',
    });
  },
  up: async (context) => {
    context.say('adding generations.input_modalities');
    await context.run({
      sql: 'ALTER TABLE generations ADD COLUMN IF NOT EXISTS input_modalities jsonb;',
    });
  },
});
