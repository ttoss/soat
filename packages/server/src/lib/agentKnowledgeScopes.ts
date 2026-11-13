import type { AuthUser } from 'src/Context';

import type { KnowledgeConfig } from './agentKnowledgeConfig';
import type { PolicyDocument } from './iam';
import type { KnowledgeScope } from './knowledge';
import {
  compileKnowledgeSearchPolicy,
  type KnowledgeSearchPolicy,
} from './knowledgeSearchPolicy';
import { readScopePolicySets } from './scopePolicySets';

/**
 * Which rows a turn's knowledge retrieval may inject, and as whom.
 *
 * The agent's stored `knowledge_config` is the agent's own and reads as the
 * agent. A generation's `knowledge_config` override is named by the caller, so
 * a row only the override reaches is read under the caller's
 * `knowledge:SearchKnowledge` policy and the agent's `policy_ids`. The turn then
 * searches the merged config as two scopes: the part the stored config also
 * reaches, unbounded, and the whole of it, bounded by that policy.
 */

const anyLength = (arr: unknown[] | undefined): boolean => {
  return (arr?.length ?? 0) > 0;
};

const anyKeys = (record: Record<string, unknown> | undefined): boolean => {
  return Object.keys(record ?? {}).length > 0;
};

export const hasKnowledgeFilters = (config: KnowledgeConfig): boolean => {
  return (
    anyLength(config.memoryStoreIds) ||
    anyLength(config.documentPaths) ||
    anyLength(config.documentIds) ||
    anyKeys(config.tags)
  );
};

// `tags` scopes both stores, so it counts on both sides: a tags-only config is
// a scoped document search, not the unscoped widening `includeDocuments` guards.
const hasMemoryStoreFilters = (config: KnowledgeConfig): boolean => {
  return anyLength(config.memoryStoreIds) || anyKeys(config.tags);
};

const hasDocumentFilters = (config: KnowledgeConfig): boolean => {
  return (
    anyLength(config.documentPaths) ||
    anyLength(config.documentIds) ||
    anyKeys(config.tags)
  );
};

/**
 * The query is derived from the chat message every turn, so it must not pick
 * the stores: each store is searched when the config names it, or when the
 * config names neither and so asks for project-wide knowledge.
 */
const scopeOf = (config: KnowledgeConfig): KnowledgeScope => {
  return {
    memoryStoreIds: config.memoryStoreIds,
    paths: config.documentPaths,
    documentIds: config.documentIds,
    tags: config.tags,
    includeDocuments:
      hasDocumentFilters(config) || !hasMemoryStoreFilters(config),
    includeMemories:
      hasMemoryStoreFilters(config) || !hasDocumentFilters(config),
  };
};

/**
 * The merged config's scope intersected with the stored config's: a filter
 * the stored config sets is kept as it is, one it leaves open takes the
 * merged value. `null` when the two cannot overlap.
 */
const withinStored = (args: {
  merged: KnowledgeScope;
  stored: KnowledgeScope;
}): KnowledgeScope | null => {
  const { merged, stored } = args;
  const conflicts = Object.entries(stored.tags ?? {}).some(([key, value]) => {
    return merged.tags?.[key] !== value;
  });
  const includeDocuments = Boolean(
    merged.includeDocuments && stored.includeDocuments
  );
  const includeMemories = Boolean(
    merged.includeMemories && stored.includeMemories
  );
  if (conflicts || (!includeDocuments && !includeMemories)) return null;
  const narrow = (
    storedValue: string[] | undefined,
    mergedValue: string[] | undefined
  ) => {
    return anyLength(storedValue) ? storedValue : mergedValue;
  };
  return {
    memoryStoreIds: narrow(stored.memoryStoreIds, merged.memoryStoreIds),
    paths: narrow(stored.paths, merged.paths),
    documentIds: narrow(stored.documentIds, merged.documentIds),
    tags: merged.tags,
    includeDocuments,
    includeMemories,
  };
};

const underPolicy = (args: {
  scope: KnowledgeScope;
  policy: KnowledgeSearchPolicy;
}): KnowledgeScope | null => {
  const { scope, policy } = args;
  if (policy.forbidden) return null;
  return {
    ...scope,
    includeMemories: policy.memoriesForbidden ? false : scope.includeMemories,
    policyWhere: policy.policyWhere,
  };
};

/** The scopes a turn searches; empty when it searches none. */
export const knowledgeScopes = (args: {
  merged: KnowledgeConfig;
  stored: KnowledgeConfig | null | undefined;
  /** Absent when the request carried no override. */
  requestedPolicy?: KnowledgeSearchPolicy;
}): KnowledgeScope[] => {
  const merged = scopeOf(args.merged);
  if (!args.requestedPolicy) return [merged];
  const scopes = [
    args.stored ? withinStored({ merged, stored: scopeOf(args.stored) }) : null,
    underPolicy({ scope: merged, policy: args.requestedPolicy }),
  ];
  return scopes.filter((scope): scope is KnowledgeScope => {
    return scope !== null;
  });
};

/**
 * The caller's `knowledge:SearchKnowledge` policy over the projects the turn
 * searches, each set bounded by the agent's boundary as one more set that
 * must allow. With no caller, the override reads nothing.
 */
export const resolveRequestedKnowledgePolicy = async (args: {
  authUser?: AuthUser;
  projectIds?: number[];
  /** Names the project when `projectIds` is unrestricted. */
  knowledgeProjectPublicId: string;
  agentPolicy: PolicyDocument | null;
}): Promise<KnowledgeSearchPolicy> => {
  if (!args.authUser) return { forbidden: true };
  const policySets = await readScopePolicySets({
    getPolicies: args.authUser.getPolicies,
    projectPublicId:
      args.projectIds === undefined ? args.knowledgeProjectPublicId : undefined,
    projectIds: args.projectIds,
  });
  // No set compiles to unrestricted access, which is no caller's policy.
  if (policySets.length === 0) return { forbidden: true };
  const { agentPolicy } = args;
  return compileKnowledgeSearchPolicy({
    policySets: agentPolicy
      ? policySets.map((set) => {
          return { ...set, policies: [...set.policies, [agentPolicy]] };
        })
      : policySets,
  });
};
