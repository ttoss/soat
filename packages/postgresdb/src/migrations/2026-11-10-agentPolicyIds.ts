import { defineMigration, type MigrationContext } from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';

type AgentRow = { id: number; public_id: string; boundary: string | null };
type VersionRow = { id: number; agent_id: number; config: string };

const literal = (value: string): string => {
  return `'${value.replaceAll("'", "''")}'`;
};

/** One policy per distinct boundary an agent or its versions carry. */
const policyMaker = (agents: AgentRow[]) => {
  const byAgent = new Map<number, Map<string, string>>();
  const inserts: string[] = [];
  const publicIdOf = new Map(
    agents.map((agent) => {
      return [agent.id, agent.public_id];
    })
  );
  const policyFor = (agentId: number, boundary: unknown): string => {
    const document = JSON.stringify(boundary);
    const known = byAgent.get(agentId) ?? new Map<string, string>();
    byAgent.set(agentId, known);
    const existing = known.get(document);
    if (existing) return existing;
    const publicId = generatePublicId(PUBLIC_ID_PREFIXES.policy);
    known.set(document, publicId);
    const name = `${publicIdOf.get(agentId) ?? agentId} boundary`;
    inserts.push(
      `INSERT INTO policies (public_id, name, document, created_at, updated_at)
       VALUES (${literal(publicId)}, ${literal(name)}, ${literal(document)}, now(), now());`
    );
    return publicId;
  };
  return { policyFor, inserts };
};

/** `config` with `boundary_policy` replaced by `policy_ids` in its place. */
const rewriteConfig = (args: {
  config: Record<string, unknown>;
  policyIds: string[] | null;
}): string => {
  const entries = Object.entries(args.config).map(([key, value]) => {
    return key === 'boundary_policy'
      ? ['policy_ids', args.policyIds]
      : [key, value];
  });
  return JSON.stringify(Object.fromEntries(entries));
};

const buildStatements = async (context: MigrationContext): Promise<string> => {
  const agents = await context.select<AgentRow>({
    sql: `SELECT id, public_id, boundary_policy::text AS boundary FROM agents`,
  });
  const versions = (await context.tableExists({ table: 'agent_versions' }))
    ? await context.select<VersionRow>({
        sql: `SELECT id, agent_id, config::text AS config FROM agent_versions
               WHERE config::jsonb ? 'boundary_policy' ORDER BY id`,
      })
    : [];
  const { policyFor, inserts } = policyMaker(agents);
  const updates: string[] = [];

  for (const agent of agents) {
    if (agent.boundary === null) continue;
    const policyId = policyFor(agent.id, JSON.parse(agent.boundary));
    updates.push(
      `UPDATE agents SET policy_ids = ${literal(JSON.stringify([policyId]))} WHERE id = ${agent.id};`
    );
  }
  for (const version of versions) {
    const config = JSON.parse(version.config) as Record<string, unknown>;
    const boundary = config.boundary_policy;
    const policyIds =
      boundary == null ? null : [policyFor(version.agent_id, boundary)];
    updates.push(
      `UPDATE agent_versions SET config = ${literal(rewriteConfig({ config, policyIds }))} WHERE id = ${version.id};`
    );
  }

  return [
    'ALTER TABLE agents ADD COLUMN IF NOT EXISTS policy_ids jsonb;',
    ...inserts,
    ...updates,
    'ALTER TABLE agents DROP COLUMN boundary_policy;',
  ].join('\n');
};

/**
 * An agent's inline `boundary_policy` becomes a stored policy named in its
 * `policy_ids`, for the live row and every archived version, so no served
 * config widens. One statement string, so no agent is left half moved.
 */
export const agentPolicyIds = defineMigration({
  name: '2026-11-10-agent-policy-ids',
  description:
    'Each agent boundary_policy, live and archived, becomes a policy named in agents.policy_ids and the version config; boundary_policy is dropped.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'agents' }))) return true;
    return !(await context.columnExists({
      table: 'agents',
      column: 'boundary_policy',
    }));
  },
  up: async (context) => {
    const sql = await buildStatements(context);
    context.say('moving agent boundary policies into policies');
    await context.run({ sql });
  },
});
