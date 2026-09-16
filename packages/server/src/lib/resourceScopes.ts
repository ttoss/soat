/**
 * What a public id authorizes against: the SRN a policy statement names, and
 * the tags its conditions read.
 *
 * One table rather than a registration each module performs on import. The
 * mapping is an authorization decision — `memories:GetMemory` is checked
 * against the memory's *store*, not the memory — so it belongs somewhere a
 * reviewer can read it end to end, and somewhere a missing entry is a failing
 * test (`soatToolsResourceScope.test.ts`) rather than a scope that silently
 * never registered.
 *
 * Every resolver mirrors the `isAllowed` call its module's routes already
 * make; the two must agree, or the agent boundary and the caller policy would
 * answer different questions about the same call. A module whose item routes
 * authorize at project level has no entry here: a boundary scoped there would
 * enforce a granularity the caller path does not have, and the place to fix
 * that is the route, as `rest/v1/agentAccess.ts` did for agents.
 */
import { getActor } from './actors';
import { findAgentScope } from './agents';
import { getConversation } from './conversations';
import { getMemory } from './memories';
import { getMemoryRule } from './memoryRules';
import { getMemoryStore } from './memoryStores';
import { findSessionAccess } from './sessions';

export type ResourceScope = {
  /** The resource type the SRN names, which is not always the id's own type. */
  resourceType: string;
  /** The public id the SRN names. */
  resourceId: string;
  projectPublicId: string;
  tags: Record<string, string> | null;
};

type ScopeResolver = (args: {
  publicId: string;
}) => Promise<ResourceScope | null>;

/**
 * The one place a missing tag bag becomes `null`. Mappers spell "no tags" as
 * `undefined` and the column as `null`; `buildResourceTagContext` takes either,
 * and a single conversion keeps every resolver below a plain projection.
 */
const toScope = (args: {
  resourceType: string;
  resourceId: string;
  projectPublicId: string;
  tags?: Record<string, string> | null;
}): ResourceScope => {
  return { ...args, tags: args.tags ?? null };
};

const memoryStoreScope: ScopeResolver = async ({ publicId }) => {
  const store = await getMemoryStore({ id: publicId });
  if (!store) return null;
  return toScope({
    resourceType: 'memory_store',
    resourceId: store.id,
    projectPublicId: store.project_id!,
    tags: store.tags,
  });
};

const RESOURCE_SCOPES: Record<string, ScopeResolver> = {
  // `getActor` and `getMemoryRule` throw on a miss rather than answering null,
  // which `resolveResourceScope` turns back into "no scope"; the ones that
  // answer null are guarded here instead.
  actor: async ({ publicId }) => {
    const actor = await getActor({ id: publicId });
    return toScope({
      resourceType: 'actor',
      resourceId: actor.id,
      projectPublicId: actor.project_id!,
      tags: actor.tags,
    });
  },

  // Agents carry no `tags` column, so a condition over resource tags reads no
  // pairs — the same as on the REST path, which checks the SRN alone.
  agent: async ({ publicId }) => {
    const scope = await findAgentScope({ id: publicId });
    if (!scope) return null;
    return toScope({
      resourceType: 'agent',
      resourceId: publicId,
      projectPublicId: scope.projectPublicId,
    });
  },

  conversation: async ({ publicId }) => {
    const conversation = await getConversation({ id: publicId });
    if (!conversation) return null;
    return toScope({
      resourceType: 'conversation',
      resourceId: conversation.id,
      projectPublicId: conversation.project_id!,
      tags: conversation.tags,
    });
  },

  // A memory authorizes against its store: `rest/v1/memories.ts` resolves the
  // entry, then checks the owning store's SRN and tags. An SRN naming the
  // memory itself would be a grant no policy author writes.
  memory: async ({ publicId }) => {
    const memory = await getMemory({ id: publicId });
    if (!memory) return null;
    return memoryStoreScope({ publicId: memory.memory_store_id! });
  },

  // A rule authorizes through the store it feeds, as `authorizeRule` does.
  memory_rule: async ({ publicId }) => {
    const rule = await getMemoryRule({ id: publicId });
    return memoryStoreScope({ publicId: rule.memory_store_id });
  },

  memory_store: memoryStoreScope,

  session: async ({ publicId }) => {
    const access = await findSessionAccess({ sessionId: publicId });
    if (!access) return null;
    return toScope({
      resourceType: 'session',
      resourceId: publicId,
      projectPublicId: access.projectPublicId,
      tags: access.tags,
    });
  },
};

export const listResourceKinds = (): string[] => {
  return Object.keys(RESOURCE_SCOPES);
};

/**
 * `null` when the kind has no resolver or the id names nothing — a caller then
 * has no SRN to evaluate, which leaves the resource-less `*`. That is the
 * fail-closed direction: `*` matches no scoped statement, so a boundary that
 * names resources refuses the call rather than admitting it unchecked.
 */
export const resolveResourceScope = async (args: {
  kind: string;
  publicId: string;
}): Promise<ResourceScope | null> => {
  const resolve = RESOURCE_SCOPES[args.kind];
  if (!resolve) return null;
  try {
    return await resolve({ publicId: args.publicId });
  } catch {
    // A miss throws in some accessors and returns null in others; both mean
    // the same thing here, and neither is this layer's error to report — the
    // request that follows answers 404 with the module's own message.
    return null;
  }
};
