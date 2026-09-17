/**
 * The authorization preamble every route that acts on **one** resource shares.
 *
 * Twelve modules used to authorize their item routes at project level: the
 * caller's policy was probed with `srn:<project>:<type>:*`, which a statement
 * naming one resource can never match, so a policy scoped to one tool or one
 * eval reached *nothing* while an action-only one reached every sibling in the
 * project. The check now names the resource, the way actors, conversations and
 * memory stores already did — which is also what lets an agent
 * `boundary_policy` be scoped to one of them, since a boundary may only promise
 * the granularity the caller path enforces (#1323, #1339).
 *
 * The two refusals are a deliberate contract rather than an accident of which
 * helper each route reached for:
 *
 * - a **read** a caller may not perform is `404`, so a resource in a project
 *   they cannot see — or one their policy does not name — does not announce its
 *   existence;
 * - a **write** is `403`, so a caller who can read a resource is told plainly
 *   that changing it is refused (#1029) — unless the resource is in a project
 *   they reach for nothing, where that would leak existence and it is `404`
 *   instead. See {@link beyondReach}.
 *
 * Which one a route picks follows what its **action** does, not which helper it
 * had reached for. Most routes agree either way — a read used the read helper —
 * but `evaluations.ts` reached for `requireProjectAccess` on its reads too, and
 * preserving that literally would have turned a cross-project read from `404`
 * into `403`, announcing across a tenant boundary that a dataset exists.
 *
 * An id that names nothing at all is `404` under both.
 *
 * `actors.ts` and `secrets.ts` are the exception, and say so at their own call
 * sites: they were already per-resource and already answered `403` on a denied
 * read, so they share the preamble at their existing shape. What they gain from
 * it is the `assertCredentialProjectScope` they were missing (#906).
 */
import type { Context } from 'src/Context';
import { DomainError, type ErrorCode } from 'src/errors';
import { buildSrn, extractProjectIdsFromPolicies } from 'src/lib/iam';
import type { ResourceScope } from 'src/lib/resourceAccessor';
import { buildResourceTagContext } from 'src/lib/tags';

import {
  assertCredentialProjectScope,
  type AuthenticatedContext,
  requireAuth,
} from './helpers';

/**
 * What the route hands its lib calls afterwards. Authorization is settled by
 * then, and narrowing to the resource's own project keeps a later lookup from
 * reaching past it.
 */
export type ResourceAccess = { projectIds: number[]; projectPublicId: string };

/**
 * Whether nothing the caller holds concerns the resource's project.
 *
 * A write refusal names a resource, so on its own it doubles as an existence
 * oracle: `403` for a resource that is there, `404` for an id that is not. That
 * is the right trade *inside* a project the caller's policies concern — being
 * told plainly that a tool is off limits tells them nothing they could not
 * already work out (#1029) — and the wrong one across a tenant boundary, where
 * it confirms a resource exists to someone with no business knowing it does.
 *
 * The question is which **project** the caller's policy set is about, not which
 * action it permits there. `resolveProjectIds` answers the second and cannot
 * stand in for the first: a statement naming one tool matches no type-level
 * probe, so it reports zero reachable projects while plainly concerning the
 * project that tool is in. Reading that as a tenant boundary would hide a
 * sibling the caller *can* see — the very refusal #1029 wants stated plainly.
 *
 * `extractProjectIdsFromPolicies` asks the first question directly, over the
 * effective documents for this request, and answers `undefined` for a statement
 * that names no project at all — an unrestricted grant, or an admin.
 *
 * A caller whose policies name **no** project is beyond every boundary rather
 * than inside none: nothing they hold concerns this project, so the least
 * privileged caller there is gets the same `404` as a made-up id.
 *
 * The net effect is that a denied write never says more than a denied read of
 * the same resource would. That is what #1029 asked for — its bug was the two
 * *disagreeing*, a write answering `404` while the caller's own `GET` answered
 * `200`, not the `403` itself, and a caller who can read a resource still gets
 * that `403` when they may not change it.
 *
 * Asked only once a call is already refused, so the permitted path pays nothing
 * for it.
 */
const beyondReach = async (args: {
  ctx: AuthenticatedContext;
  scope: ResourceScope;
}): Promise<boolean> => {
  const named = extractProjectIdsFromPolicies(
    await args.ctx.authUser.getPolicies(args.scope.projectPublicId)
  );

  if (named === undefined) return false;
  return !named.includes(args.scope.projectPublicId);
};

export const authorizeResource = async (args: {
  ctx: Context;
  /**
   * Where the resource lives and what it is tagged with, from the module's
   * `accessor.findScope` — or its **parent's**, for a nested resource that
   * carries no project of its own. `null` means the id names nothing, which is
   * the `404` below.
   */
  scope: ResourceScope | null;
  /** The type the SRN names, which for a nested resource is the parent's. */
  resourceType: string;
  /** The id the SRN names, likewise the parent's where the scope is. */
  resourceId: string;
  action: string;
  /** What a refusal reads as; see the module comment. */
  onDenied: 'hide' | 'refuse';
  /**
   * The noun a `404` names, e.g. `Tool`. Usually the scope's own noun: on a
   * nested route whose parent id is in the path, the parent is what could not
   * be reached — a child that is simply missing is the lib's own `404`.
   */
  label: string;
  /**
   * The id a `404` names, when it is not the one the SRN names. They differ
   * only where the caller never named the resource being authorized against:
   * an orchestration **run** authorizes through its orchestration, so the SRN
   * names the orchestration while the caller asked for a run.
   */
  missingId?: string;
  /**
   * The module's own not-found code, where it has one
   * (`ORCHESTRATION_RUN_NOT_FOUND`). Defaults to `RESOURCE_NOT_FOUND`, and must
   * match what the module's accessor throws — a preamble that answers a
   * different code for the same absence is the shape split
   * `errorShapeContract.test.ts` exists to prevent.
   */
  errorCode?: ErrorCode;
}): Promise<ResourceAccess> => {
  const { ctx } = args;
  requireAuth(ctx);

  const notFound = new DomainError(
    args.errorCode ?? 'RESOURCE_NOT_FOUND',
    `${args.label} '${args.missingId ?? args.resourceId}' not found.`
  );

  if (!args.scope) throw notFound;

  // A credential pinned to another project keeps its own refusal, with the
  // remedy in the message; without this it would read as a plain denial.
  assertCredentialProjectScope({
    ctx,
    requestedProjectPublicId: args.scope.projectPublicId,
    action: args.action,
  });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: args.scope.projectPublicId,
    action: args.action,
    resource: buildSrn({
      projectPublicId: args.scope.projectPublicId,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
    }),
    // The tags come off the same row the SRN names — `scope`, not a second
    // lookup — so a `soat:ResourceTag/<key>` condition can never be evaluated
    // against one resource while the SRN names another.
    context: buildResourceTagContext({
      resourceType: args.resourceType,
      tags: args.scope.tags,
    }),
  });

  if (!allowed) {
    const hide =
      args.onDenied === 'hide' ||
      (await beyondReach({ ctx, scope: args.scope }));

    throw hide ? notFound : new DomainError('FORBIDDEN', 'Forbidden');
  }

  return {
    projectIds: [args.scope.projectId],
    projectPublicId: args.scope.projectPublicId,
  };
};

/** What an item route hands {@link makeItemRouteAuthorizer} per call. */
type ItemRouteArgs = { ctx: Context; action: string };

/**
 * The binding of {@link authorizeResource} to one module: where the scope comes
 * from, what the SRN calls the resource, which path parameter names it, and the
 * noun a `404` uses. Twelve modules need exactly that and nothing else, so the
 * repetition lives here instead of once per module.
 *
 * A **nested** route binds its **parent**: `/evals/:eval_id/runs/:eval_run_id`
 * authorizes against the eval, because that is the resource a policy author
 * names and the one that carries the project. The child id is the lib call's
 * business, not the permission check's.
 */
export const makeItemRouteAuthorizer = (config: {
  /** Usually `<accessor>.findScope` from the module's `lib/` accessor. */
  findScope: (args: { id: string }) => Promise<ResourceScope | null>;
  resourceType: string;
  /** The `ctx.params` key carrying the public id, e.g. `tool_id`. */
  param: string;
  label: string;
  /** See {@link authorizeResource}'s `errorCode`. */
  errorCode?: ErrorCode;
}) => {
  const authorize = async (
    args: ItemRouteArgs & { onDenied: 'hide' | 'refuse' }
  ): Promise<ResourceAccess> => {
    const resourceId = args.ctx.params[config.param];

    return authorizeResource({
      ctx: args.ctx,
      scope: await config.findScope({ id: resourceId }),
      resourceType: config.resourceType,
      resourceId,
      label: config.label,
      errorCode: config.errorCode,
      action: args.action,
      onDenied: args.onDenied,
    });
  };

  return {
    /** A read: a refusal is indistinguishable from absence. */
    authorizeRead: (args: ItemRouteArgs): Promise<ResourceAccess> => {
      return authorize({ ...args, onDenied: 'hide' });
    },
    /** Anything that changes the resource or runs it: a refusal says so. */
    authorizeWrite: (args: ItemRouteArgs): Promise<ResourceAccess> => {
      return authorize({ ...args, onDenied: 'refuse' });
    },
    /**
     * The refusal named outright, for the module whose existing contract does
     * not follow the read/write rule — `secrets.ts` answers `403` on a denied
     * read, and preserving that is not the same decision as making a read hide.
     */
    authorize,
  };
};
