import { db } from '../db';
import { scopedWhere } from './resourceAccessor';

/**
 * Resolving the public ids a listing or a rollup filters on into the internal
 * ids a `where` clause keys on.
 *
 * Its own module because three surfaces need the same rule and the same
 * failure mode — the usage event listing, the generation listing and the usage
 * rollup — and each held its own copy of it. A filter naming a resource that
 * does not exist in the caller's project scope resolves to `null` and empties
 * the answer instead of being dropped: a narrowing silently ignored reads back
 * as the project's whole traffic, a wrong answer rather than a missing one
 * (#1265).
 */

type Finder = (
  where: Record<string, unknown>
) => Promise<{ id?: number } | null>;

/** Every resource a filter can name, and the table it resolves against. */
const SCOPED_ID_MODELS = {
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
  session: (where) => {
    return db.Session.findOne({ where });
  },
  trace: (where) => {
    return db.Trace.findOne({ where });
  },
} satisfies Record<string, Finder>;

export type ScopedIdResource = keyof typeof SCOPED_ID_MODELS;

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
  return row?.id ?? null;
};

/**
 * The internal id of every filter that named one, keyed as the caller asked.
 * Filters left unset are absent from the result; `null` is returned when any
 * one of them names nothing in scope, which is the caller's cue to answer
 * empty.
 *
 * The reads are independent, so they go together — a rollup narrowed on five
 * dimensions should not cost five round trips before the first aggregate runs.
 */
export const resolveScopedIds = async <K extends string>(args: {
  filters: Array<ScopedIdFilter<K>>;
  projectIds?: number[];
}): Promise<Partial<Record<K, number>> | null> => {
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

  const ids: Partial<Record<K, number>> = {};
  for (const entry of resolved) {
    if (entry.id === null) return null;
    ids[entry.key] = entry.id;
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
