/**
 * Common helper functions for REST API handlers.
 *
 * Every guard here **throws** a `DomainError` rather than writing a response.
 * That is the rule `.claude/rules/errors.md` states and the one these helpers
 * used to contradict: `checkAuth`/`requireAdmin` set `ctx.body = { error: '…' }`
 * by hand, so the shared helpers institutionalized the ❌ example and 349 call
 * sites followed it (#913). Throwing also removes the `return` bookkeeping that
 * every caller had to remember — a forgotten `return` after a boolean guard
 * continued into the handler body with the response already set.
 *
 * The auth/scope preamble lives here and nowhere else (#908). Before, ~170
 * routes re-derived it inline and eight modules kept a private `check*Access`
 * clone differing only in a `resourceType` string literal; each copy was free to
 * pick a different failure, which is the substrate the scoped-key `403`
 * inconsistency grew in. `tests/unit/tests/rest/errorShapeContract.test.ts`
 * enforces both properties statically.
 */
import type { AuthUser, Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  principalFromAuthUser,
  type RequestPrincipal,
} from 'src/lib/principals';
import { recordAuthorizationDecision } from 'src/middleware/audit';

/**
 * Throws an actionable `API_KEY_PROJECT_SCOPE` error when a project-scoped
 * credential (API key or OAuth token) explicitly targets a different project
 * than the one it is bound to.
 *
 * This binding is a hard boundary enforced independently of the owner's role:
 * an admin-owned key can create projects freely (the project create/delete gate
 * is role-based) but is still confined to its own project for resource
 * operations. Surfacing the reason here turns the otherwise opaque `403
 * Forbidden` into a message that names both projects and points at the fix.
 *
 * The denial is recorded before it is thrown. This check short-circuits ahead of
 * `resolveProjectIds`, so the audit middleware's wrapper never observes it —
 * without the explicit record, refusing a cross-project request would leave no
 * audit entry at all, the same #745 class the `requireAdmin` comment below
 * describes.
 *
 * No-op when the credential is unscoped, or when the requested project matches
 * the credential's project.
 *
 * `null` is a *target*, not an absence: it means the request names no project at
 * all — minting an unscoped API key, or managing one. A confined credential must
 * be refused there too, or the boundary is one `POST /api-keys` deep (#1038).
 * Pass `undefined`-as-`null` only when the route has genuinely resolved the
 * target to "no project"; a route with nothing to check should not call this.
 */
export const assertCredentialProjectScope = (args: {
  ctx: Context;
  requestedProjectPublicId: string | null;
  action: string;
}): void => {
  const { ctx, requestedProjectPublicId } = args;
  const authUser = ctx.authUser!;
  const scopedProject =
    authUser.apiKeyProjectPublicId ?? authUser.oauthProjectPublicId;

  if (!scopedProject || scopedProject === requestedProjectPublicId) {
    return;
  }

  recordAuthorizationDecision(ctx, { action: args.action, allowed: false });

  const credential = authUser.apiKeyProjectPublicId ? 'API key' : 'OAuth token';
  const reason =
    requestedProjectPublicId === null
      ? `cannot create or manage an unscoped credential. Use an unscoped ` +
        `credential to do that.`
      : `cannot access project '${requestedProjectPublicId}'. Mint a key ` +
        `scoped to '${requestedProjectPublicId}' (or an unscoped key) to ` +
        `operate there.`;

  // Meta keys are snake_case to match the external REST contract.
  throw new DomainError(
    'API_KEY_PROJECT_SCOPE',
    `This ${credential} is scoped to project '${scopedProject}' and ${reason}`,
    {
      scoped_project: scopedProject,
      requested_project: requestedProjectPublicId,
    }
  );
};

/**
 * The project-owning field of a resource a route authorizes against, declared
 * **required but possibly `undefined`** rather than optional (`project_id?:`).
 *
 * The distinction is the whole point. A lib return whose `project_id` is a
 * mapped-but-empty association satisfies this type; a lib return that is
 * *missing the field altogether* — because a mapper named it `projectId`, or
 * forgot it — does not, and fails to typecheck at the helper boundary.
 *
 * `project_id?: string` accepted both, which is how #801 shipped: the object
 * type-checked, `doc.project_id` was `undefined` at runtime, and the
 * authorization call then reached the DB with an undefined `WHERE` binding and
 * threw a raw 500. Excess-property checking does not cover it — the object is
 * passed as a variable, not an inline literal.
 *
 * Intersect it into the resource shape a permission helper accepts:
 * `doc: { id: string; path?: string } & ProjectOwned`.
 */
export type ProjectOwned = { project_id: string | undefined };

/**
 * Parses `limit` / `offset` list pagination params from the query string.
 * Returns `undefined` for a param that is absent or not a valid integer, so the
 * lib layer applies its own defaults/bounds (see `lib/pagination.ts`).
 */
export const parsePagination = (
  ctx: Context
): { limit?: number; offset?: number } => {
  const toInt = (value: unknown): number | undefined => {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    limit: toInt(ctx.query.limit),
    offset: toInt(ctx.query.offset),
  };
};

/** A `Context` past {@link requireAuth}: `authUser` is guaranteed present. */
export type AuthenticatedContext = Context & { authUser: AuthUser };

/**
 * Asserts the request is authenticated, throwing `UNAUTHORIZED` otherwise.
 *
 * Declared as a TypeScript **assertion** rather than a function returning the
 * user, so a bare `requireAuth(ctx);` narrows `ctx.authUser` for the rest of the
 * block. That is what lets the guard replace the inline
 * `if (!ctx.authUser) { … return; }` blocks without every handler also having to
 * thread a returned value around — and it retires the `ctx.authUser!` non-null
 * assertions those blocks used to make necessary, so a handler that forgets the
 * guard no longer typechecks.
 *
 * (An assertion signature needs an explicitly annotated call target, hence the
 * type-then-implementation form.)
 *
 * Prefer {@link resolveReadProjectIds} / {@link resolveWriteProjectId}, which
 * run this themselves — a route that needs project scope should not also call
 * this. It stands alone only where a handler genuinely has no project to
 * resolve (`/users/me`, the OAuth introspection routes, sub-resource routes
 * that authorize against a parent they load first).
 */
export const requireAuth: (
  ctx: Context
) => asserts ctx is AuthenticatedContext = (ctx) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }
};

/**
 * Gates a route on the caller's role being `admin` — the hard, non-IAM gate
 * used by global (non-project-scoped) admin operations (users, policies,
 * projects, the price book) where no policy can grant access; only the
 * `admin` role itself can. Throws `UNAUTHORIZED`/`FORBIDDEN`.
 *
 * Records the decision for the audit log via `recordAuthorizationDecision` —
 * this comparison bypasses `isAllowed`/`resolveProjectIds` entirely, so
 * without this call the request produces no audit entry at all, even on a
 * successful mutation (see #745).
 */
export const requireAdmin = (ctx: Context, action: string): void => {
  requireAuth(ctx);

  const allowed = ctx.authUser.role === 'admin';
  recordAuthorizationDecision(ctx, { action, allowed });

  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
};

/**
 * Gates a route on the caller either owning the resource or being an admin —
 * the API-key rule, where a user administers their own keys and an admin
 * administers everyone's. Unlike {@link requireAdmin} this is not a pure role
 * gate, so it needs the owner to compare against.
 *
 * Shared for the same reason `requireAdmin` is: the comparison bypasses
 * `isAllowed`/`resolveProjectIds`, so the decision is invisible to the audit log
 * unless it is recorded explicitly. `apiKeys.ts` open-coded this three times and
 * two of the three remembered the record — the read did not.
 *
 * Throws `UNAUTHORIZED`/`FORBIDDEN`.
 */
export const requireOwnerOrAdmin = (
  ctx: Context,
  args: { ownerPublicId: string | null | undefined; action: string }
): void => {
  requireAuth(ctx);

  const allowed =
    args.ownerPublicId === ctx.authUser.publicId ||
    ctx.authUser.role === 'admin';
  recordAuthorizationDecision(ctx, { action: args.action, allowed });

  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
};

/**
 * The read/list preamble, in one place: authenticate, enforce the credential's
 * project binding, then resolve the project ids the caller may read for this
 * action.
 *
 * `undefined` means "no project filter" — a JWT admin with no explicit
 * `project_id`. Lib list/get functions already treat an `undefined` `projectIds`
 * that way, so the return type is passed straight through.
 *
 * Every non-admin read route funnels through here. That is the point: the eight
 * `check*Access` clones this replaces differed only in a `resourceType` literal,
 * yet 21 of 25 read routes reached the variant *without*
 * `assertCredentialProjectScope`, so a scoped key got an opaque `Forbidden`
 * instead of a message naming both projects (#906). With one preamble there is
 * no second variant to pick.
 */
export const resolveReadProjectIds = async (args: {
  ctx: Context;
  projectPublicId?: string;
  action: string;
  resourceType?: string;
}): Promise<number[] | undefined> => {
  const { ctx } = args;
  requireAuth(ctx);

  // A scoped credential targeting a different project fails with an actionable
  // error rather than the opaque `Forbidden` that resolveProjectIds would yield.
  if (args.projectPublicId) {
    assertCredentialProjectScope({
      ctx,
      requestedProjectPublicId: args.projectPublicId,
      action: args.action,
    });
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId: args.projectPublicId,
    action: args.action,
    resourceType: args.resourceType,
  });

  if (projectIds === null) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  return projectIds;
};

/**
 * {@link resolveReadProjectIds}, but an **empty** scope is also a `403`.
 *
 * The two differ on one case, and it is a real distinction rather than an
 * accident. `resolveReadProjectIds` lets `[]` through because "the caller may
 * read zero projects" is a correct answer for a list route: the filter matches
 * nothing and the response is `[]`. A route that then fetches one resource and
 * checks whether its project is in the caller's set cannot use that answer — an
 * empty set would make the resource look *missing* rather than *forbidden*,
 * turning an authorization failure into a `404`.
 *
 * `undefined` still means "unrestricted" (a JWT admin) and stays permitted;
 * only a non-null, zero-length array is rejected. Getting that pair backwards is
 * why the check was written out inline 17 times instead of shared — the comment
 * explaining it appeared in exactly one of the copies.
 */
export const requireProjectAccess = async (args: {
  ctx: Context;
  projectPublicId?: string;
  action: string;
  resourceType?: string;
}): Promise<number[] | undefined> => {
  const projectIds = await resolveReadProjectIds(args);

  if (Array.isArray(projectIds) && projectIds.length === 0) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  return projectIds;
};

/**
 * Resolves the numeric project id for a create/write operation.
 *
 * - An explicit `projectPublicId` is used as-is, subject to the permission check.
 * - When omitted, a project-scoped API key or project-scoped OAuth token supplies its
 *   own project automatically (implicit project id).
 * - A scoped credential with an explicit `projectPublicId` that does not match the
 *   credential's project resolves to 403.
 * - When omitted without a scoped credential (e.g. plain JWT auth), throws
 *   `VALIDATION_FAILED` — a write needs a concrete project and one is never
 *   inferred from a JWT user's accessible projects.
 *
 * Returns the numeric project id; throws `UNAUTHORIZED` / `VALIDATION_FAILED` /
 * `API_KEY_PROJECT_SCOPE` / `FORBIDDEN` otherwise.
 */
export const resolveWriteProjectId = async (args: {
  ctx: Context;
  projectPublicId?: string;
  action: string;
  resourceType?: string;
}): Promise<number> => {
  const { ctx, action } = args;
  requireAuth(ctx);

  // Without an explicit project id, a project-scoped API key or OAuth token supplies a default.
  const projectPublicId =
    args.projectPublicId ??
    ctx.authUser.apiKeyProjectPublicId ??
    ctx.authUser.oauthProjectPublicId;

  if (!projectPublicId) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required');
  }

  // A scoped credential targeting a different project fails with an actionable
  // error rather than the opaque `Forbidden` that resolveProjectIds would yield.
  // `projectPublicId` here already defaulted to the credential's own project
  // when omitted, so this only fires on an explicit, mismatching project id.
  assertCredentialProjectScope({
    ctx,
    requestedProjectPublicId: projectPublicId,
    action,
  });

  // resolveProjectIds runs the permission check and, for a scoped key, returns null
  // when projectPublicId does not match the key's project (→ 403). Every
  // resolveProjectIds implementation, given a truthy projectPublicId (guaranteed
  // above), either returns null or a single-element array — so the resolved id is
  // always defined here.
  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action,
    resourceType: args.resourceType,
  });

  if (projectIds === null) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  return projectIds![0];
};

export type { RequestPrincipal } from 'src/lib/principals';

/**
 * The principal to credit for an action, resolved from the auth context only —
 * never from a body. Attribution that a caller cannot address is the whole point
 * (#853), so the derivation lives here rather than per handler.
 *
 * The rule itself is `principalFromAuthUser`, shared with the audit middleware
 * and task transitions; this is just the `ctx` adapter for it.
 */
export const requestPrincipalFromCtx = (ctx: Context): RequestPrincipal => {
  return principalFromAuthUser(ctx.authUser!);
};
