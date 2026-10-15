import { db } from '../db';
import { scopedWhere } from './resourceAccessor';
import { agentReferences, toolReferences } from './resourceReferences';

/**
 * Resolving the public ids a listing or a rollup filters on into the internal
 * ids a `where` clause keys on.
 *
 * Its own module because three surfaces need the same rule — the usage event
 * listing, the generation listing and the usage rollup. A filter naming a
 * resource that does not exist in the caller's project scope resolves to
 * `null` instead of being dropped (a publisher project is looked up by id
 * alone: the listing is already confined to the caller's projects): a
 * narrowing silently ignored reads back as the project's whole traffic, a
 * wrong answer rather than a missing one. The generation listing empties its
 * answer on a `null`; a usage read matches the public id its events recorded
 * instead (`usageNarrowings.ts`).
 */

type Finder = (
  where: Record<string, unknown>
) => Promise<{ id?: number } | null>;

/**
 * Every resource a filter can name. Spelled out rather than inferred from the
 * table below: a model thunk's return type drags Sequelize's whole instance
 * surface into the inferred type, which `tsc` cannot serialize (TS2883).
 */
export type ScopedIdResource =
  | 'actor'
  | 'agent'
  | 'aiProvider'
  | 'generation'
  | 'orchestration'
  | 'orchestrationRun'
  | 'publisherProject'
  | 'session'
  | 'tool'
  | 'trace';

/** The table each one resolves against. */
const SCOPED_ID_MODELS: Record<ScopedIdResource, Finder> = {
  actor: (where) => {
    return db.Actor.findOne({ where });
  },
  agent: (where) => {
    return db.Agent.findOne({ where });
  },
  aiProvider: (where) => {
    return db.AiProvider.findOne({ where });
  },
  generation: (where) => {
    return db.Generation.findOne({ where });
  },
  orchestration: (where) => {
    return db.Orchestration.findOne({ where });
  },
  orchestrationRun: (where) => {
    return db.OrchestrationRun.findOne({ where });
  },
  publisherProject: (where) => {
    return db.Project.findOne({ where: { publicId: where.publicId } });
  },
  session: (where) => {
    return db.Session.findOne({ where });
  },
  tool: (where) => {
    return db.Tool.findOne({ where });
  },
  trace: (where) => {
    return db.Trace.findOne({ where });
  },
};

// A tool or agent another project shares with one in scope is metered in that
// project's events and generations, so it narrows them like one of its own.
const SHARED_REFERENCES: Partial<
  Record<ScopedIdResource, typeof toolReferences | typeof agentReferences>
> = { tool: toolReferences, agent: agentReferences };

/** One narrowing: which resource the id names, under which key to file it. */
export type ScopedIdFilter<K extends string = string> = {
  key: K;
  resource: ScopedIdResource;
  publicId: string | undefined;
};

const resolveOne = async (args: {
  resource: ScopedIdResource;
  publicId: string;
  projectIds?: number[];
}): Promise<number | null> => {
  const row = await SCOPED_ID_MODELS[args.resource](
    scopedWhere({
      id: args.publicId,
      ...(args.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
    })
  );
  const references = SHARED_REFERENCES[args.resource];
  if (row || !references || args.projectIds === undefined) {
    return row?.id ?? null;
  }
  for (const projectId of args.projectIds) {
    const shared = await references.find({
      id: args.publicId,
      projectId,
      reach: 'shares',
    });
    if (shared) return shared.id ?? null;
  }
  return null;
};

/**
 * Each filter that named something, resolved on its own: its internal id, or
 * `null` when it names nothing in scope. Filters left unset are absent.
 *
 * The reads are independent, so they go together — a rollup narrowed on five
 * dimensions should not cost five round trips before the first aggregate runs.
 */
export const resolveEachScopedId = async <K extends string>(args: {
  filters: Array<ScopedIdFilter<K>>;
  projectIds?: number[];
}): Promise<Partial<Record<K, number | null>>> => {
  const requested = args.filters.filter(
    (filter): filter is ScopedIdFilter<K> & { publicId: string } => {
      return filter.publicId !== undefined;
    }
  );

  const resolved = await Promise.all(
    requested.map(async (filter) => {
      return {
        key: filter.key,
        id: await resolveOne({
          resource: filter.resource,
          publicId: filter.publicId,
          ...(args.projectIds !== undefined
            ? { projectIds: args.projectIds }
            : {}),
        }),
      };
    })
  );

  const ids: Partial<Record<K, number | null>> = {};
  for (const entry of resolved) ids[entry.key] = entry.id;
  return ids;
};

/**
 * The internal id of every filter that named one, keyed as the caller asked.
 * `null` is returned when any one of them names nothing in scope, which is the
 * caller's cue to answer empty.
 */
export const resolveScopedIds = async <K extends string>(args: {
  filters: Array<ScopedIdFilter<K>>;
  projectIds?: number[];
}): Promise<Partial<Record<K, number>> | null> => {
  const each = await resolveEachScopedId(args);
  const ids: Partial<Record<K, number>> = {};
  for (const [key, id] of Object.entries(each) as Array<[K, number | null]>) {
    if (id === null) return null;
    ids[key] = id;
  }
  return ids;
};

/**
 * The same resolution written into a Sequelize `where` (mutating it), for the
 * listings that build one. `false` means a filter named nothing in scope.
 */
export const applyScopedIdFilters = async (args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: Record<string, any>;
  filters: ScopedIdFilter[];
  projectIds?: number[];
}): Promise<boolean> => {
  const ids = await resolveScopedIds({
    filters: args.filters,
    ...(args.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
  });
  if (!ids) return false;

  Object.assign(args.where, ids);
  return true;
};
