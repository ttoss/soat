import { defineMigration } from '@ttoss/postgresdb';

/**
 * `agents.run_as`, what an agent's `policy_ids` are. Every existing agent is
 * `caller`: its `policy_ids` cap the caller, so none widens.
 */
export const agentRunAs = defineMigration({
  name: '2026-11-13-agent-run-as',
  description: "agents.run_as, NOT NULL, default 'caller'.",
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'agents' }))) return true;
    return context.columnExists({ table: 'agents', column: 'run_as' });
  },
  up: async (context) => {
    context.say('adding agents.run_as');
    await context.run({
      sql: "ALTER TABLE agents ADD COLUMN IF NOT EXISTS run_as varchar(16) NOT NULL DEFAULT 'caller';",
    });
  },
});
