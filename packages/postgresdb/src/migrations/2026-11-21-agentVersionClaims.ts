import { defineMigration } from '@ttoss/postgresdb';

/**
 * `agent_versions.released_claims`, the claims a promotion gave up. Nothing to
 * fill: no release could give a claim up before this column exists.
 */
export const agentVersionClaims = defineMigration({
  name: '2026-11-21-agent-version-claims',
  description:
    'agent_versions.released_claims, the claims a promotion gave up.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'agent_versions' }))) return true;
    return context.columnExists({
      table: 'agent_versions',
      column: 'released_claims',
    });
  },
  up: async (context) => {
    context.say('adding agent_versions.released_claims');
    await context.run({
      sql: 'ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS released_claims json;',
    });
  },
});
