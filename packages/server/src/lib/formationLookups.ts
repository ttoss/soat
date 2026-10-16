import { db } from 'src/db';

import { DomainError, type ErrorCode } from '../errors';
import {
  agentReferences,
  type ReferenceReach,
  toolReferences,
} from './resourceReferences';

/**
 * Resolves a resource's public id to the internal primary key a lib argument
 * needs, or throws with the resource named.
 *
 * One body for every resource: the model and the noun are the only things that
 * vary, and the model types make an `as unknown as { id: number }` double cast
 * unnecessary.
 */
const lookupInternalId = async (args: {
  model: {
    findOne: (options: {
      where: { publicId: string; projectId: number };
    }) => Promise<{ id: number } | null>;
  };
  label: string;
  code: ErrorCode;
  publicId: string;
  projectId: number;
}): Promise<number> => {
  const row = await args.model.findOne({
    where: { publicId: args.publicId, projectId: args.projectId },
  });
  // The same error a public id that does not exist at all raises, deliberately:
  // a distinguishable "exists, but elsewhere" would make this an oracle for ids
  // in other projects.
  if (!row) {
    throw new DomainError(
      args.code,
      `${args.label} not found: ${args.publicId}`
    );
  }
  return row.id;
};

/**
 * The project a lookup is confined to.
 *
 * `projectId` is **required** on every one of these: the REST routes resolve a
 * caller-supplied id with the project in the `where`, and the formation modules
 * resolved it on the public id alone — so a template deployed into project A
 * could name project B's `sec_…` and get a provider in A holding B's
 * credential. Public ids appear in responses, traces and deploy logs, so they
 * are
 * not an access boundary. Every call site is a module `create`/`update`, which
 * runs under a known project, so there is no case where the value is genuinely
 * unavailable.
 */
export type ScopedLookupArgs = { publicId: string; projectId: number };

export const lookupSecretInternalId = (
  args: ScopedLookupArgs
): Promise<number> => {
  return lookupInternalId({
    model: db.Secret,
    label: 'Secret',
    code: 'SECRET_NOT_FOUND',
    ...args,
  });
};

export const lookupMemoryStoreInternalId = (
  args: ScopedLookupArgs
): Promise<number> => {
  return lookupInternalId({
    model: db.MemoryStore,
    label: 'Memory store',
    code: 'MEMORY_STORE_NOT_FOUND',
    ...args,
  });
};

export const lookupActorInternalId = (
  args: ScopedLookupArgs
): Promise<number> => {
  return lookupInternalId({
    model: db.Actor,
    label: 'Actor',
    code: 'ACTOR_NOT_FOUND',
    ...args,
  });
};

// Tools and agents resolve through `resourceReferences`, like every other
// reference to them, with the same error as `lookupInternalId`.
/** `reach` is the referencing field's, as its REST route resolves it. */
export const lookupAgentInternalId = async (
  args: ScopedLookupArgs & { reach: ReferenceReach }
): Promise<number> => {
  const agent = await agentReferences.find({
    id: args.publicId,
    projectId: args.projectId,
    reach: args.reach,
  });
  if (!agent) {
    throw new DomainError(
      'AGENT_NOT_FOUND',
      `Agent not found: ${args.publicId}`
    );
  }
  return agent.id as number;
};

export const lookupToolInternalId = async (
  args: ScopedLookupArgs & { reach: ReferenceReach }
): Promise<number> => {
  const tool = await toolReferences.find({
    id: args.publicId,
    projectId: args.projectId,
    reach: args.reach,
  });
  if (!tool) {
    throw new DomainError('TOOL_NOT_FOUND', `Tool not found: ${args.publicId}`);
  }
  return tool.id as number;
};

export const lookupPolicyInternalIds = async (
  publicIds: string[]
): Promise<number[]> => {
  if (publicIds.length === 0) return [];
  const policies = await db.Policy.findAll({ where: { publicId: publicIds } });
  if (policies.length !== publicIds.length) {
    const foundIds = new Set(
      policies.map((policy) => {
        return policy.publicId;
      })
    );
    const missing = publicIds.find((id) => {
      return !foundIds.has(id);
    });
    throw new DomainError('POLICY_NOT_FOUND', `Policy not found: ${missing}`);
  }
  return policies.map((policy) => {
    return policy.id;
  });
};
