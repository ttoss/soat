import { db } from '../db';

/**
 * Where a carrier acting in every project its owner reaches acts. A project
 * policy reaches only its own project, so there it narrows to that project.
 */
export const EVERY_PROJECT = '*';

/**
 * How attaching a policy to the carrier is checked. `writer_holds_grants`: the
 * writer must hold every grant it adds. `bounded_by_owner`: the carrier acts
 * under its owner's policies intersected with its own, so an attach narrows
 * it; a narrowed writer is held to its own boundary (`boundKeyPolicyIds`).
 */
export type PolicyAttachCheck = 'writer_holds_grants' | 'bounded_by_owner';

export type PolicyCarrier = {
  /** The models whose rows name the policies, by `@soat/postgresdb` name. */
  models: string[];
  attach: PolicyAttachCheck;
  /**
   * The project public id of every row naming the policy, or `EVERY_PROJECT`
   * for one acting in every project. An edit to the policy is checked in each.
   */
  actsIn: (policy: { id: number; publicId: string }) => Promise<string[]>;
};

const publicIdsOf = async (args: {
  sql: string;
  replacements: Record<string, unknown>;
}): Promise<string[]> => {
  const [rows] = await db.sequelize.query(args.sql, {
    replacements: args.replacements,
  });
  return (rows as { public_id: string }[]).map((row) => {
    return row.public_id;
  });
};

/** A carrier naming policies by public id in a jsonb `policy_ids` column. */
const projectJsonbCarrier = (args: {
  model: string;
  table: string;
}): PolicyCarrier => {
  return {
    models: [args.model],
    attach: 'writer_holds_grants',
    actsIn: (policy) => {
      return publicIdsOf({
        sql: `SELECT DISTINCT p.public_id
                FROM ${args.table} c
                JOIN projects p ON p.id = c.project_id
               WHERE c.policy_ids @> :ids::jsonb`,
        replacements: { ids: JSON.stringify([policy.publicId]) },
      });
    },
  };
};

/**
 * Every resource whose attached policies grant what it may do. A model gaining
 * a policy attachment joins here (`tests/harness/policyCarriers.test.mjs`).
 */
export const POLICY_CARRIERS = {
  // An archived version is served again by a release or a restore.
  agents: {
    models: ['Agent', 'AgentVersion'],
    attach: 'writer_holds_grants',
    actsIn: (policy) => {
      return publicIdsOf({
        sql: `SELECT DISTINCT p.public_id
                FROM agents a
                JOIN projects p ON p.id = a.project_id
               WHERE a.policy_ids @> :ids::jsonb
                  OR EXISTS (
                       SELECT 1 FROM agent_versions v
                        WHERE v.agent_id = a.id
                          AND (v.config::jsonb -> 'policy_ids') @> :ids::jsonb)`,
        replacements: { ids: JSON.stringify([policy.publicId]) },
      });
    },
  },
  triggers: projectJsonbCarrier({ model: 'Trigger', table: 'triggers' }),
  webhooks: projectJsonbCarrier({ model: 'Webhook', table: 'webhooks' }),
  apiKeys: {
    models: ['ApiKey'],
    attach: 'bounded_by_owner',
    actsIn: (policy) => {
      return publicIdsOf({
        sql: `SELECT DISTINCT COALESCE(p.public_id, :every) AS public_id
                FROM api_keys k
                LEFT JOIN projects p ON p.id = k.project_id
               WHERE :id = ANY(k.policy_ids)`,
        replacements: { id: policy.id, every: EVERY_PROJECT },
      });
    },
  },
  users: {
    models: ['User'],
    attach: 'writer_holds_grants',
    actsIn: (policy) => {
      return publicIdsOf({
        sql: `SELECT DISTINCT :every AS public_id
                FROM users u
               WHERE :id = ANY(u.policy_ids)`,
        replacements: { id: policy.id, every: EVERY_PROJECT },
      });
    },
  },
} satisfies Record<string, PolicyCarrier>;

export type PolicyCarrierName = keyof typeof POLICY_CARRIERS;
