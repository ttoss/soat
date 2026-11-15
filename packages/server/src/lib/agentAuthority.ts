import { db } from '../db';
import { type AgentRunAs, readAgentRunAs } from './agentRunAs';
import { resolveAttachedPolicies } from './attachedPolicies';
import type { DeniedPrincipal } from './authorizationDenial';
import type { PolicyDocument, PolicySets } from './iam';

/** One document every call the agent boundary covers must satisfy. */
export type BoundaryPolicy = { by: DeniedPrincipal; policy: PolicyDocument };

/**
 * An agent's `policy_ids` resolved for one turn, carried with the agent's
 * public id so a refusal names whose policies denied, and what they are
 * (`runAs`). Under `agent`, `grant` is the turn's whole grant inside
 * `projectPublicId` and `null` grants nothing. `boundary` caps every call in
 * both modes: the agent's `policy_ids` and its owner project's
 * `agent_policy_ids`, read through the helpers below. `agentId: null` only
 * where the agent no longer resolves.
 */
export type AgentAuthority =
  | {
      runAs: 'caller';
      agentId: string | null;
      boundary: BoundaryPolicy[];
    }
  | {
      runAs: 'agent';
      agentId: string;
      grant: PolicyDocument | null;
      boundary: BoundaryPolicy[];
      projectPublicId: string;
      /** The owner project whose `agent_policy_ids` cap the turn. */
      capProject: string;
    };

/** The owner project's `agent_policy_ids`, bound to `actorId`. */
const resolveProjectCap = async (args: {
  ownerProjectId: number;
  actorId: string | null | undefined;
}): Promise<{ project: string; policy: PolicyDocument | null } | null> => {
  const project = await db.Project.findByPk(args.ownerProjectId, {
    attributes: ['publicId', 'agentPolicyIds'],
  });
  if (!project) return null;
  return {
    project: project.publicId,
    policy: await resolveAttachedPolicies({
      policyIds: project.agentPolicyIds,
      actorId: args.actorId,
    }),
  };
};

/**
 * The authority of agent `agentId` for a turn in `projectPublicId`, its
 * `policy_ids` and its owner project's `agent_policy_ids` bound to `actorId`.
 */
export const resolveAgentAuthority = async (args: {
  agentId: string;
  runAs: unknown;
  policyIds: unknown;
  actorId: string | null | undefined;
  projectPublicId: string;
  /** The project the agent belongs to: a shared agent's owner. */
  ownerProjectId: number;
}): Promise<AgentAuthority> => {
  const [policy, cap] = await Promise.all([
    resolveAttachedPolicies({
      policyIds: args.policyIds,
      actorId: args.actorId,
    }),
    resolveProjectCap(args),
  ]);
  const boundary: BoundaryPolicy[] = [];
  if (policy) {
    boundary.push({ by: { type: 'agent', id: args.agentId }, policy });
  }
  if (cap?.policy) {
    boundary.push({
      by: { type: 'project', id: cap.project },
      policy: cap.policy,
    });
  }
  const runAs: AgentRunAs = readAgentRunAs(args.runAs);
  if (runAs === 'caller') return { runAs, agentId: args.agentId, boundary };
  return {
    runAs,
    agentId: args.agentId,
    grant: policy,
    boundary,
    projectPublicId: args.projectPublicId,
    capProject: cap?.project ?? args.projectPublicId,
  };
};

/** The authority of an agent that no longer resolves: it allows nothing. */
export const unresolvedAgentAuthority = (
  agentId: string | null
): AgentAuthority => {
  return {
    runAs: 'caller',
    agentId,
    boundary: [
      {
        by: { type: 'agent', id: agentId },
        policy: {
          statement: [{ effect: 'Deny', action: ['*'], resource: ['*'] }],
        },
      },
    ],
  };
};

/** The agent a turn acts as: set only under `run_as: agent`. */
export const actingAgentOf = (authority: AgentAuthority): string | null => {
  return authority.runAs === 'agent' ? authority.agentId : null;
};

/** The agent's own `policy_ids`, when it carries any. */
export const agentPolicyOf = (
  authority: AgentAuthority
): PolicyDocument | null => {
  return (
    authority.boundary.find(({ by }) => {
      return by.type === 'agent';
    })?.policy ?? null
  );
};

/** The owner project's `agent_policy_ids`, when it sets any. */
export const projectCapOf = (
  authority: AgentAuthority
): BoundaryPolicy | null => {
  return (
    authority.boundary.find(({ by }) => {
      return by.type === 'project';
    }) ?? null
  );
};

/** The boundary's documents, each one more set every check must satisfy. */
export const boundarySets = (
  authority: AgentAuthority | undefined
): PolicySets => {
  return (authority?.boundary ?? []).map(({ policy }) => {
    return [policy];
  });
};
