import { resolveAttachedPolicies } from './attachedPolicies';
import type { PolicyDocument } from './iam';

/**
 * An agent's `policy_ids` resolved for one turn, carried with the agent's
 * public id so a refusal names whose policies denied. `policy: null` is no
 * cap; `agentId: null` only where the agent no longer resolves.
 */
export type AgentBoundary = {
  agentId: string | null;
  policy: PolicyDocument | null;
};

/** The boundary of agent `agentId`, its `policy_ids` bound to `actorId`. */
export const resolveAgentBoundary = async (args: {
  agentId: string;
  policyIds: unknown;
  actorId: string | null | undefined;
}): Promise<AgentBoundary> => {
  return {
    agentId: args.agentId,
    policy: await resolveAttachedPolicies({
      policyIds: args.policyIds,
      actorId: args.actorId,
    }),
  };
};
