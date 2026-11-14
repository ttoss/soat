import { defineMigration } from '@ttoss/postgresdb';

/**
 * `tools.trusted_output`, and the provenance counts a generation carries:
 * `generations.untrusted_tool_results` and `generations.knowledge_results`.
 * Every existing tool is untrusted and every recorded turn counts zero.
 */
export const generationProvenance = defineMigration({
  name: '2026-11-14-generation-provenance',
  description:
    'tools.trusted_output, generations.untrusted_tool_results and knowledge_results.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'generations' }))) return true;
    return context.columnExists({
      table: 'generations',
      column: 'knowledge_results',
    });
  },
  up: async (context) => {
    context.say('adding tools.trusted_output and generation provenance counts');
    await context.run({
      sql: `ALTER TABLE tools ADD COLUMN IF NOT EXISTS trusted_output boolean NOT NULL DEFAULT false;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS untrusted_tool_results integer NOT NULL DEFAULT 0;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS knowledge_results integer NOT NULL DEFAULT 0;`,
    });
  },
});
