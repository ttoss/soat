import { defineMigration } from '@ttoss/postgresdb';

/**
 * `generations.input_modalities`, the part types a turn's input carried.
 * Rows recorded before it read as `[]`, the same as a turn naming no part.
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
      sql: "ALTER TABLE generations ADD COLUMN IF NOT EXISTS input_modalities jsonb NOT NULL DEFAULT '[]'::jsonb;",
    });
  },
});
