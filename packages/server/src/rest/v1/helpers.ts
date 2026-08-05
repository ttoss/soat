/**
 * Common helper functions for REST API handlers
 */
import type { AuthUser, Context } from 'src/Context';
import { DomainError } from 'src/errors';
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
 * No-op when the credential is unscoped, or when the requested project matches
 * the credential's project.
 */
const assertCredentialProjectScope = (args: {
  authUser: AuthUser;
  requestedProjectPublicId: string;
}): void => {
  const { authUser, requestedProjectPublicId } = args;
  const scopedProject =
    authUser.apiKeyProjectPublicId ?? authUser.oauthProjectPublicId;

  if (!scopedProject || scopedProject === requestedProjectPublicId) {
    return;
  }

  const credential = authUser.apiKeyProjectPublicId ? 'API key' : 'OAuth token';
  // Meta keys are snake_case to match the external REST contract.
  throw new DomainError(
    'API_KEY_PROJECT_SCOPE',
    `This ${credential} is scoped to project '${scopedProject}' and cannot ` +
      `access project '${requestedProjectPublicId}'. Mint a key scoped to ` +
      `'${requestedProjectPublicId}' (or an unscoped key) to operate there.`,
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

/**
 * Checks if user is authenticated and returns error response if not
 */
export const checkAuth = (ctx: Context): boolean => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return false;
  }
  return true;
};

/**
 * Gates a route on the caller's role being `admin` — the hard, non-IAM gate
 * used by global (non-project-scoped) admin operations (users, policies,
 * projects, the price book) where no policy can grant access; only the
 * `admin` role itself can. Sets `401`/`403` and returns `false` when the
 * caller should stop; the route should `return` immediately in that case.
 *
 * Records the decision for the audit log via `recordAuthorizationDecision` —
 * this comparison bypasses `isAllowed`/`resolveProjectIds` entirely, so
 * without this call the request produces no audit entry at all, even on a
 * successful mutation (see #745).
 */
export const requireAdmin = (ctx: Context, action: string): boolean => {
  if (!checkAuth(ctx)) return false;

  const allowed = ctx.authUser!.role === 'admin';
  recordAuthorizationDecision(ctx, { action, allowed });

  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return false;
  }
  return true;
};

/**
 * Resolves project IDs for an action with permission check
 */
export const resolveProjectIdsWithAction = async (args: {
  ctx: Context;
  projectPublicId?: string;
  action: string;
  resourceType?: string;
}): Promise<number[] | null | undefined> => {
  // Every call site runs this after `checkAuth(ctx)`, so `ctx.authUser` is
  // always defined here.
  const authUser = args.ctx.authUser!;

  // A scoped credential targeting a different project fails with an actionable
  // error rather than the opaque `Forbidden` that resolveProjectIds would yield.
  if (args.projectPublicId) {
    assertCredentialProjectScope({
      authUser,
      requestedProjectPublicId: args.projectPublicId,
    });
  }

  const projectIds = await authUser.resolveProjectIds({
    projectPublicId: args.projectPublicId,
    action: args.action,
    resourceType: args.resourceType,
  });

  if (projectIds === null) {
    args.ctx.status = 403;
    args.ctx.body = { error: 'Forbidden' };
    return null;
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
 * - When omitted without a scoped credential (e.g. plain JWT auth), responds 400 —
 *   a write needs a concrete project and one is never inferred from a JWT user's
 *   accessible projects.
 *
 * Returns the numeric project id, or `null` when a response (401/400/403) has already
 * been set on `ctx` and the caller should `return`.
 */
export const resolveWriteProjectId = async (args: {
  ctx: Context;
  projectPublicId?: string;
  action: string;
  resourceType?: string;
}): Promise<number | null> => {
  const { ctx, action } = args;
  // Every call site runs this after `checkAuth(ctx)`, so `ctx.authUser` is
  // always defined here.
  const authUser = ctx.authUser!;

  // Without an explicit project id, a project-scoped API key or OAuth token supplies a default.
  const projectPublicId =
    args.projectPublicId ??
    authUser.apiKeyProjectPublicId ??
    authUser.oauthProjectPublicId;

  if (!projectPublicId) {
    ctx.status = 400;
    ctx.body = { error: 'project_id is required' };
    return null;
  }

  // A scoped credential targeting a different project fails with an actionable
  // error rather than the opaque `Forbidden` that resolveProjectIds would yield.
  // `projectPublicId` here already defaulted to the credential's own project
  // when omitted, so this only fires on an explicit, mismatching project id.
  assertCredentialProjectScope({
    authUser,
    requestedProjectPublicId: projectPublicId,
  });

  // resolveProjectIds runs the permission check and, for a scoped key, returns null
  // when projectPublicId does not match the key's project (→ 403). Every
  // resolveProjectIds implementation, given a truthy projectPublicId (guaranteed
  // above), either returns null or a single-element array — so the resolved id is
  // always defined here.
  const projectIds = await authUser.resolveProjectIds({
    projectPublicId,
    action,
    resourceType: args.resourceType,
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }

  return projectIds![0];
};

export type RequestPrincipal = {
  principalType: 'user' | 'api_key';
  principalId: string;
};

/**
 * The principal to credit for an action, resolved from the auth context only —
 * never from a body. For API-key auth the id is the key's own public id
 * (`key_…`) so the record names *which* key acted, not just that a key did;
 * `apiKeyPublicId` is set for both scoped and unscoped keys, so it (not
 * `apiKeyProjectId`) decides the type.
 *
 * One definition for a rule that is repeated verbatim wherever attribution is
 * stamped: content purges (#836), discussion runs (#858), task transitions, and
 * the audit middleware. Attribution that a caller cannot address is the whole
 * point (#853), so the derivation lives here rather than per handler.
 */
export const requestPrincipalFromCtx = (ctx: Context): RequestPrincipal => {
  const apiKeyPublicId = ctx.authUser!.apiKeyPublicId;
  if (apiKeyPublicId) {
    return { principalType: 'api_key', principalId: apiKeyPublicId };
  }
  return { principalType: 'user', principalId: ctx.authUser!.publicId };
};
