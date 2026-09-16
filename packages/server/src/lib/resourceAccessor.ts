import createDebug from 'debug';

import { db } from '../db';
import { DomainError, type ErrorCode } from '../errors';
import type { ResourceIncludes } from './modelIncludes';
import { isStringRecord } from './tags';

/**
 * The minimum a `db.*` model has to offer for the accessor to drive it. Kept
 * structural rather than naming a Sequelize `ModelStatic`, which is not
 * portably nameable from an emitted declaration.
 */
type FinderModel = {
  findOne: (options: {
    where?: Record<string, unknown>;
    include?: ResourceIncludes;
  }) => Promise<unknown>;
};

/**
 * `{ publicId }`, narrowed to `projectIds` when a credential scope is in play.
 *
 * Passing `projectIds: []` is a scope that matches nothing, which is what makes
 * an out-of-scope id read as absent rather than as forbidden. Spelling that as
 * `projectIds.length > 0` instead — as `orchestrationStartRun.ts` did — drops
 * the filter entirely and turns an empty scope into *no* scope.
 *
 * Exported on its own because a module can need this rule without needing an
 * accessor: `ingestionRuleRefs.ts` and `pipelineTools.ts` resolve a *referenced*
 * entity, so a miss is a `400` carrying their own context rather than the `404`
 * `getByPublicId` throws. They borrow the scope rule and keep their own throw.
 */
export const scopedWhere = (args: {
  id: string;
  projectIds?: number[];
  /**
   * Extra predicates merged into the `where` — a resource-specific filter the
   * lookup is never valid without, such as a soft-delete exclusion. Column
   * names, not wire field names; the object is passed through without any key
   * being read.
   */
  where?: Record<string, unknown>;
}): Record<string, unknown> => {
  const where: Record<string, unknown> = { publicId: args.id, ...args.where };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;
  return where;
};

/**
 * Everything an authorization preamble needs about a resource *before* it
 * decides: which project it belongs to — in both spellings, the numeric id the
 * lib layer filters on and the public id an SRN names — and the tags a
 * `soat:ResourceTag/<key>` condition reads.
 *
 * The tags travel with the scope rather than alongside it so an SRN and the
 * condition context can never come from two different rows, which is the one
 * way a `Deny` scoped by tag silently stops matching.
 */
export type ResourceScope = {
  projectId: number;
  projectPublicId: string;
  /** `null` for a model with no `tags` column: a condition reads no pairs. */
  tags: Record<string, string> | null;
};

const log = createDebug('soat:resourceAccessor');

/**
 * What {@link makeResourceAccessor}'s `findScope` reads off the row it loads.
 * Every field is optional and checked at runtime, because a model with no
 * `projectId` type-checks here and must answer `null` rather than an SRN built
 * out of `undefined`.
 */
type ScopedProjectRow = {
  projectId?: unknown;
  project?: { publicId?: unknown } | null;
  tags?: unknown;
};

/**
 * What {@link makeResourceAccessor} returns, named rather than inferred.
 *
 * An inferred shape reaches into `sequelize-typescript`'s internals through
 * `TRow`, which `tsc` cannot write into an emitted declaration (`TS2883`) once a
 * module exports its accessor — and exporting it is exactly what lets the route
 * preamble and the boundary table read the same `findScope`.
 */
export type ResourceAccessor<TRow> = {
  findByPublicId: (args: {
    id: string;
    projectIds?: number[];
    where?: Record<string, unknown>;
  }) => Promise<TRow | null>;
  findScope: (args: { id: string }) => Promise<ResourceScope | null>;
  getByPublicId: (args: {
    id: string;
    projectIds?: number[];
    where?: Record<string, unknown>;
    errorCode?: ErrorCode;
  }) => Promise<TRow>;
  notFound: (id: string, errorCode?: ErrorCode) => DomainError;
  reload: (row: { id?: unknown }) => Promise<TRow>;
  scopedWhere: typeof scopedWhere;
};

/**
 * Builds the four queries every resource module in `src/lib` was writing by
 * hand: the scoped `where`, the scoped lookup, its throwing counterpart, and
 * the reload-after-write.
 *
 * The accessor never receives, inspects or emits a **field name** — it moves
 * whole rows and builds a `where` out of column names. Each module keeps its own
 * explicit `mapX` and calls `mapActor(await actors.reload(row))`. That is the
 * hard constraint from #912: no key-rewriting surface is added here
 * (`.claude/rules/case-convention.md`), confirmable from this signature alone.
 *
 * `TRow` is the module's loaded-row type. A Sequelize `findOne` result is typed
 * as the bare model instance with no association properties, which is why
 * twenty call sites double-cast; declaring the row type once per module moves
 * the cast here.
 *
 * @example
 * ```ts
 * const actors = makeResourceAccessor<ActorRow>({
 *   model: () => db.Actor,
 *   includes: actorIncludes,
 *   label: 'Actor',
 * });
 * const actor = await actors.getByPublicId({ id, projectIds });
 * return mapActor(await actors.reload(actor));
 * ```
 */
export const makeResourceAccessor = <TRow extends { id?: unknown }>(config: {
  /**
   * Thunk, not a value: `db.*` models are only populated after the database
   * initializes, so referencing one at module load time yields `undefined`.
   */
  model: () => FinderModel;
  /** Same reason the model is a thunk. Omit for a resource with no associations. */
  includes?: () => ResourceIncludes;
  /** The noun the not-found message names, e.g. `Actor`. */
  label: string;
  /** Defaults to `RESOURCE_NOT_FOUND`. */
  errorCode?: ErrorCode;
}): ResourceAccessor<TRow> => {
  const notFound = (id: string, errorCode?: ErrorCode) => {
    return new DomainError(
      errorCode ?? config.errorCode ?? 'RESOURCE_NOT_FOUND',
      `${config.label} '${id}' not found.`
    );
  };

  const findByPublicId = async (args: {
    id: string;
    projectIds?: number[];
    where?: Record<string, unknown>;
  }): Promise<TRow | null> => {
    const row = await config.model().findOne({
      where: scopedWhere(args),
      include: config.includes?.(),
    });
    return row as TRow | null;
  };

  const getByPublicId = async (args: {
    id: string;
    projectIds?: number[];
    where?: Record<string, unknown>;
    /**
     * Overrides the accessor's code for this call. A module whose resource is
     * a top-level `404` on its own routes but a `400`-class referenced-entity
     * miss elsewhere (`CHAT_NOT_FOUND`) names the second code here, rather
     * than dropping back to a hand-rolled lookup.
     */
    errorCode?: ErrorCode;
  }): Promise<TRow> => {
    const row = await findByPublicId(args);
    if (!row) throw notFound(args.id, args.errorCode);
    return row;
  };

  /**
   * The project a public id belongs to: what a route has to know *before* it
   * can authorize against the resource's own SRN.
   *
   * Loaded with a `publicId`-only `Project` include rather than the module's
   * own `includes`, because this runs ahead of the authorization decision: a
   * caller who turns out not to be allowed must not have paid for the
   * resource's full association graph, and no part of it is read here.
   *
   * `null` is every reason the lookup cannot answer — no such id, or a model
   * with no project to answer with. Both fail closed: the route has no SRN to
   * check, and answers `404` from {@link notFound}.
   *
   * A resource whose model carries no `projectId` (`DatasetItem`, `EvalRun`,
   * `GuardrailVersion`, `OrchestrationVersion`) is not one of these — it
   * authorizes through the parent that does, the way a memory authorizes
   * through its store.
   */
  const findScope = async (args: {
    id: string;
  }): Promise<ResourceScope | null> => {
    log('findScope: label=%s id=%s', config.label, args.id);

    const row = (await config.model().findOne({
      where: { publicId: args.id },
      include: [{ model: db.Project, as: 'project', attributes: ['publicId'] }],
    })) as ScopedProjectRow | null;

    const projectId = row?.projectId;
    const projectPublicId = row?.project?.publicId;
    if (typeof projectId !== 'number' || typeof projectPublicId !== 'string') {
      return null;
    }

    // A JSONB column is `unknown` until something checks it; a bag that is not
    // flat strings is no bag, not a bag to coerce (`.claude/rules/tags.md`).
    const tags = isStringRecord(row?.tags) ? row.tags : null;

    return { projectId, projectPublicId, tags };
  };

  /**
   * Re-reads a row by its internal id with the module's includes attached —
   * the step after a `create` or `update`, whose result the module's mapper
   * needs the associations of.
   */
  const reload = async (row: { id?: unknown }): Promise<TRow> => {
    const reloaded = await config.model().findOne({
      where: { id: row.id },
      include: config.includes?.(),
    });
    return reloaded as TRow;
  };

  return {
    findByPublicId,
    findScope,
    getByPublicId,
    notFound,
    reload,
    scopedWhere,
  };
};
