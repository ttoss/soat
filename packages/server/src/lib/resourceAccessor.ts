import { DomainError, type ErrorCode } from '../errors';
import type { ResourceIncludes } from './modelIncludes';

/**
 * The minimum a `db.*` model has to offer for the accessor to drive it. Kept
 * structural (rather than importing a Sequelize `ModelStatic`) so this module
 * has no dependency beyond `../errors`.
 */
type FinderModel = {
  findOne: (options: {
    where?: Record<string, unknown>;
    include?: ResourceIncludes;
  }) => Promise<unknown>;
};

/**
 * Builds the four queries every resource module in `src/lib` was writing out
 * by hand: the scoped `where`, the scoped lookup, its throwing counterpart,
 * and the reload-after-write.
 *
 * ## Rows in, rows out
 *
 * The accessor never receives, inspects, or emits a **field name** — it moves
 * whole rows and builds a `where` out of column names (`publicId`, `projectId`,
 * `id`). Each module keeps its own explicit field-by-field `mapX` and calls
 * `mapActor(await actors.reload(row))`. That is the hard constraint from #912:
 * no key-rewriting surface is added here, so
 * `.claude/rules/case-convention.md`'s prohibition is untouched, and a reviewer
 * can confirm it from this signature alone.
 *
 * ## `TRow` is the module's loaded-row type
 *
 * A Sequelize `findOne` result is typed as the bare model instance, with no
 * association properties — which is why twenty call sites double-cast the
 * result to their mapper's parameter type. Declare the loaded-row type once
 * per module, pass it as `TRow`, and the cast happens once, here, instead of
 * at every call site.
 *
 * @example
 * ```ts
 * type ActorRow = InstanceType<(typeof db)['Actor']> & {
 *   project?: InstanceType<(typeof db)['Project']>;
 * };
 *
 * const actors = makeResourceAccessor<ActorRow>({
 *   model: () => db.Actor,
 *   includes: actorIncludes,
 *   label: 'Actor',
 * });
 *
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
}) => {
  const notFound = (id: string, errorCode?: ErrorCode) => {
    return new DomainError(
      errorCode ?? config.errorCode ?? 'RESOURCE_NOT_FOUND',
      `${config.label} '${id}' not found.`
    );
  };

  /**
   * `{ publicId }`, narrowed to `projectIds` when a credential scope is in
   * play. Passing `projectIds: []` is a scope that matches nothing, which is
   * what makes an out-of-scope id read as absent rather than as forbidden.
   */
  const scopedWhere = (args: {
    id: string;
    projectIds?: number[];
    /**
     * Extra predicates merged into the `where` — a resource-specific filter
     * the lookup is never valid without, such as a soft-delete exclusion.
     * Column names, not wire field names; the accessor passes the object
     * through without reading a key.
     */
    where?: Record<string, unknown>;
  }): Record<string, unknown> => {
    const where: Record<string, unknown> = { publicId: args.id, ...args.where };
    if (args.projectIds !== undefined) where.projectId = args.projectIds;
    return where;
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

  return { findByPublicId, getByPublicId, notFound, reload, scopedWhere };
};
