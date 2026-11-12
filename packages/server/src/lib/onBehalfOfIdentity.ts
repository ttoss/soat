import createDebug from 'debug';

import { db } from '../db';
import { resolveAgentForGeneration } from './agentGenerationRecovery';
import { resolveServedAgentVersion } from './agentServedVersion';
import {
  resolveAttachedPolicies,
  resolveAttachedPolicySet,
  resolveBoundSet,
} from './attachedPolicies';
import type { PolicySets } from './iam';
import { resolvePolicySets } from './permissions';
import { parseBound } from './principalBound';

const log = createDebug('soat:onBehalfOfIdentity');

/** A set with no document: it allows nothing. */
const NOTHING: PolicySets = [[]];

const userSets = async (args: {
  userId?: number;
  publicId?: string;
  apiKeyPolicyIds: number[];
}): Promise<PolicySets> => {
  const user = await db.User.findOne({
    where:
      args.userId !== undefined
        ? { id: args.userId }
        : { publicId: args.publicId },
    attributes: ['role', 'policyIds'],
  });
  if (!user) return NOTHING;
  return resolvePolicySets({
    userRole: user.role as 'admin' | 'user',
    userPolicyIds: (user.policyIds as number[] | null) ?? [],
    apiKeyPolicyIds: args.apiKeyPolicyIds,
    db,
  });
};

const principalSets = async (args: {
  type: string;
  id: string;
}): Promise<PolicySets> => {
  if (args.type === 'user') {
    return userSets({ publicId: args.id, apiKeyPolicyIds: [] });
  }
  if (args.type !== 'api_key') return NOTHING;
  const key = await db.ApiKey.findOne({
    where: { publicId: args.id },
    attributes: ['userId', 'policyIds'],
  });
  if (!key) return NOTHING;
  return userSets({
    userId: key.userId as number,
    apiKeyPolicyIds: (key.policyIds as number[] | null) ?? [],
  });
};

/** The grant of the principal a generation's tool calls ran as. */
const actedAsSets = async (args: {
  type: string;
  id: string;
  bound: unknown;
}): Promise<PolicySets> => {
  const bound = parseBound(args.bound);
  if (bound === null) return NOTHING;
  const principal = await principalSets(args);
  return bound ? [...principal, await resolveBoundSet(bound)] : principal;
};

/**
 * The caller half: its `acted_as` principal and, when fired, the trigger's.
 * A turn that records neither (a session or conversation turn) has none, so
 * the agent half alone narrows the key.
 */
const callerSets = async (
  gen: InstanceType<(typeof db)['Generation']>
): Promise<PolicySets> => {
  const sets: PolicySets = [];
  if (gen.actedAsPrincipalType && gen.actedAsPrincipalId) {
    sets.push(
      ...(await actedAsSets({
        type: gen.actedAsPrincipalType,
        id: gen.actedAsPrincipalId,
        bound: gen.actedAsPrincipalBound,
      }))
    );
  }
  if (gen.triggerId) {
    const trigger = await db.Trigger.findOne({
      where: { publicId: gen.triggerId },
      attributes: ['policyIds'],
    });
    sets.push(
      await resolveAttachedPolicySet({ policyIds: trigger?.policyIds ?? null })
    );
  }
  return sets;
};

/** The agent half: the served version's `policy_ids`, bound to the actor. */
const agentSets = async (
  gen: InstanceType<(typeof db)['Generation']>
): Promise<PolicySets> => {
  const agent = await resolveAgentForGeneration({
    agentId: gen.agentPublicId,
    runProjectId: gen.projectId,
  });
  if (!agent) return NOTHING;
  const { typedAgent } = await resolveServedAgentVersion({
    agent,
    pinnedVersion: gen.agentVersion,
  });
  const grant = await resolveAttachedPolicies({
    policyIds: typedAgent.policyIds,
    actorId: gen.startedByActor?.publicId ?? null,
  });
  return grant ? [[grant]] : [];
};

/**
 * The policy sets a generation's execution identity must each satisfy: its
 * caller's and its agent's `policy_ids`, the same pair a `builtin` call is
 * held to. A generation outside `projectPublicId` allows nothing.
 */
export const resolveGenerationIdentitySets = async (args: {
  generationPublicId: string;
  projectPublicId: string;
}): Promise<PolicySets> => {
  const gen = await db.Generation.findOne({
    where: { publicId: args.generationPublicId },
    include: [
      { model: db.Project, as: 'project', attributes: ['publicId'] },
      { model: db.Actor, as: 'startedByActor', attributes: ['publicId'] },
    ],
  });
  if (!gen || gen.project?.publicId !== args.projectPublicId) {
    log(
      'resolveGenerationIdentitySets: %s unresolved',
      args.generationPublicId
    );
    return NOTHING;
  }
  const [caller, agent] = await Promise.all([callerSets(gen), agentSets(gen)]);
  return [...caller, ...agent];
};
