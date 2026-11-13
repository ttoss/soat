import { type AgentRunAs, readAgentRunAs } from './agentRunAs';
import { resolveAttachedPolicies } from './attachedPolicies';
import type { PolicyDocument } from './iam';

/**
 * An agent's `policy_ids` resolved for one turn, carried with the agent's
 * public id so a refusal names whose policies denied, and what they are
 * (`runAs`). Under `caller`, `policy` caps the caller and `null` is no cap.
 * Under `agent`, `policy` is the turn's whole grant inside `projectPublicId`
 * and `null` grants nothing. `agentId: null` only where the agent no longer
 * resolves.
 */
export type AgentAuthority =
  | {
      runAs: 'caller';
      agentId: string | null;
      policy: PolicyDocument | null;
    }
  | {
      runAs: 'agent';
      agentId: string;
      policy: PolicyDocument | null;
      projectPublicId: string;
    };

/**
 * The authority of agent `agentId` for a turn in `projectPublicId`, its
 * `policy_ids` bound to `actorId`.
 */
export const resolveAgentAuthority = async (args: {
  agentId: string;
  runAs: unknown;
  policyIds: unknown;
  actorId: string | null | undefined;
  projectPublicId: string;
}): Promise<AgentAuthority> => {
  const policy = await resolveAttachedPolicies({
    policyIds: args.policyIds,
    actorId: args.actorId,
  });
  const runAs: AgentRunAs = readAgentRunAs(args.runAs);
  if (runAs === 'caller') return { runAs, agentId: args.agentId, policy };
  return {
    runAs,
    agentId: args.agentId,
    policy,
    projectPublicId: args.projectPublicId,
  };
};

/** The agent a turn acts as: set only under `run_as: agent`. */
export const actingAgentOf = (authority: AgentAuthority): string | null => {
  return authority.runAs === 'agent' ? authority.agentId : null;
};
