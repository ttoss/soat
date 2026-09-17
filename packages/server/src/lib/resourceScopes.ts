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
 * Every entry mirrors the `isAllowed` call its module's routes already make;
 * the two must agree, or the agent boundary and the caller policy would answer
 * different questions about the same call. That agreement is now structural
 * rather than careful: both sides read the **same** `accessor.findScope`, the
 * route through `rest/v1/resourceAccess.ts` and the boundary through here, so
 * there is no second projection of a row to drift.
 *
 * A module whose item routes still authorize at project level has no entry
 * here: a boundary scoped there would enforce a granularity the caller path
 * does not have, and the place to fix that is the route
 * (`errorShapeContract.test.ts` now fails such a route outright).
 */
import { actors } from './actors';
import { agents } from './agentAccessor';
import { auditEntries } from './auditLog';
import { conversations } from './conversations';
import { datasets } from './evaluationDatasets';
import { evals } from './evaluations';
import { chains } from './generationChains';
import { generations } from './generations';
import { guardrails } from './guardrails';
import { ingestionRules } from './ingestionRules';
import { getMemory } from './memories';
import { getMemoryRule } from './memoryRules';
import { memoryStores } from './memoryStores';
import { modelRoutes } from './modelRoutes';
import {
  findRunOrchestrationId,
  orchestrations,
} from './orchestrationAccessor';
import { quotas } from './quotas';
import type { ResourceScope } from './resourceAccessor';
import { findSessionAccess } from './sessions';
import { tools } from './tools';
import { traceRows } from './traces';
import { thresholds } from './usageThresholds';

/** The resource a policy statement names, resolved from a public id. */
export type ScopedResource = ResourceScope & {
  /** The resource type the SRN names, which is not always the id's own type. */
  resourceType: string;
  /** The public id the SRN names, likewise. */
  resourceId: string;
};

/** The one thing this table needs of an accessor. */
type ScopeAccessor = {
  findScope: (args: { id: string }) => Promise<ResourceScope | null>;
};

/**
 * Either the resource carries its own project — and its accessor's `findScope`
 * answers — or it is a child that authorizes through a parent, and all this
 * table holds is which parent, and how to get its id.
 *
 * `accessor` is a thunk for the same reason `makeResourceAccessor`'s `model` is:
 * an agent's tool surface reaches this table through `soatActionBoundary`, so
 * `lib/tools.ts` can still be mid-initialization when this module body runs and
 * its accessor binding is not populated yet. Reading it per call rather than at
 * load time is what keeps the table free to name any module.
 */
type ResourceKind =
  | { accessor: () => ScopeAccessor; resourceType: string }
  | { via: string; parentId: (args: { id: string }) => Promise<string | null> };

/**
 * Sessions predate the accessor — `findSessionAccess` also resolves the agent,
 * which nothing else about a scope needs — so the scope is the part of its
 * answer this table reads.
 */
const sessionAccessor: ScopeAccessor = {
  findScope: async ({ id }) => {
    return findSessionAccess({ sessionId: id });
  },
};

const RESOURCE_KINDS: Record<string, ResourceKind> = {
  actor: {
    accessor: () => {
      return actors;
    },
    resourceType: 'actor',
  },

  // Agents carry no `tags` column, so a condition over resource tags reads no
  // pairs — the same as on the REST path, which checks the SRN alone.
  agent: {
    accessor: () => {
      return agents;
    },
    resourceType: 'agent',
  },

  audit: {
    accessor: () => {
      return auditEntries;
    },
    resourceType: 'audit',
  },

  chain: {
    accessor: () => {
      return chains;
    },
    resourceType: 'chain',
  },

  conversation: {
    accessor: () => {
      return conversations;
    },
    resourceType: 'conversation',
  },

  // A dataset item and an eval run carry no project of their own, so both the
  // route and a boundary authorize them through the parent the path names.
  dataset: {
    accessor: () => {
      return datasets;
    },
    resourceType: 'dataset',
  },

  eval: {
    accessor: () => {
      return evals;
    },
    resourceType: 'eval',
  },

  generation: {
    accessor: () => {
      return generations;
    },
    resourceType: 'generation',
  },

  guardrail: {
    accessor: () => {
      return guardrails;
    },
    resourceType: 'guardrail',
  },

  // camelCase, unlike every other SRN type — renaming it is a public-contract
  // change of its own.
  ingestionRule: {
    accessor: () => {
      return ingestionRules;
    },
    resourceType: 'ingestionRule',
  },

  // A memory authorizes against its store: `rest/v1/memories.ts` resolves the
  // entry, then checks the owning store's SRN and tags. An SRN naming the
  // memory itself would be a grant no policy author writes.
  memory: {
    via: 'memory_store',
    parentId: async ({ id }) => {
      return (await getMemory({ id }))?.memory_store_id ?? null;
    },
  },

  // A rule authorizes through the store it feeds, as `authorizeRule` does.
  memory_rule: {
    via: 'memory_store',
    parentId: async ({ id }) => {
      return (await getMemoryRule({ id })).memory_store_id;
    },
  },

  memory_store: {
    accessor: () => {
      return memoryStores;
    },
    resourceType: 'memory_store',
  },

  model_route: {
    accessor: () => {
      return modelRoutes;
    },
    resourceType: 'model_route',
  },

  orchestration: {
    accessor: () => {
      return orchestrations;
    },
    resourceType: 'orchestration',
  },

  // A run authorizes through the orchestration it runs, which is the resource
  // type its routes have always probed — naming the run itself would be a new
  // type no existing `srn:<project>:orchestration:*` statement covers.
  orchestration_run: { via: 'orchestration', parentId: findRunOrchestrationId },

  quota: {
    accessor: () => {
      return quotas;
    },
    resourceType: 'quota',
  },

  session: {
    accessor: () => {
      return sessionAccessor;
    },
    resourceType: 'session',
  },

  tool: {
    accessor: () => {
      return tools;
    },
    resourceType: 'tool',
  },

  trace: {
    accessor: () => {
      return traceRows;
    },
    resourceType: 'trace',
  },

  // A usage *threshold*, under the SRN type its route has always probed.
  usage: {
    accessor: () => {
      return thresholds;
    },
    resourceType: 'usage',
  },
};

export const listResourceKinds = (): string[] => {
  return Object.keys(RESOURCE_KINDS);
};

/**
 * `null` when the kind has no entry or the id names nothing — a caller then
 * has no SRN to evaluate, which leaves the resource-less `*`. That is the
 * fail-closed direction: `*` matches no scoped statement, so a boundary that
 * names resources refuses the call rather than admitting it unchecked.
 */
export const resolveResourceScope = async (args: {
  kind: string;
  publicId: string;
}): Promise<ScopedResource | null> => {
  const entry = RESOURCE_KINDS[args.kind];
  if (!entry) return null;

  try {
    if ('via' in entry) {
      const parentId = await entry.parentId({ id: args.publicId });
      if (!parentId) return null;
      return resolveResourceScope({ kind: entry.via, publicId: parentId });
    }

    const scope = await entry.accessor().findScope({ id: args.publicId });
    if (!scope) return null;

    // Projected field by field rather than spread: `findSessionAccess` answers
    // a superset, and a spread would carry its agent ids into a scope nothing
    // here means to publish.
    return {
      projectId: scope.projectId,
      projectPublicId: scope.projectPublicId,
      tags: scope.tags,
      resourceType: entry.resourceType,
      resourceId: args.publicId,
    };
  } catch {
    // A miss throws in some accessors and returns null in others; both mean
    // the same thing here, and neither is this layer's error to report — the
    // request that follows answers 404 with the module's own message.
    return null;
  }
};
