import { defineMigration } from '@ttoss/postgresdb';

/**
 * `agent_versions.claims`, the claims a promotion stood on. Nothing to fill:
 * a version promoted without the column has no recorded claims.
 */
export const agentVersionPromotionClaims = defineMigration({
  name: '2026-11-21-agent-version-promotion-claims',
  description: 'agent_versions.claims, the claims a promotion stood on.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'agent_versions' }))) return true;
    return context.columnExists({ table: 'agent_versions', column: 'claims' });
  },
  up: async (context) => {
    context.say('adding agent_versions.claims');
    await context.run({
      sql: 'ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS claims json;',
    });
  },
});
