/**
 * Common helper functions for REST API handlers.
 *
 * Every guard here **throws** a `DomainError` rather than writing a response,
 * the rule `.claude/rules/errors.md` states. Throwing also removes the `return`
 * bookkeeping a boolean guard needs, where a forgotten `return` continues into
 * the handler with the response already set.
 *
 * The auth/scope preamble lives here and nowhere else. Re-derived inline per
 * route, or kept as a private `check*Access` clone per module, each copy is
 * free to pick a different failure. `rest/errorShapeContract.test.ts` enforces
 * both properties statically.
 */
import type { AuthUser, Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  EMBEDDING_SPEND,
  firstProjectByPublicId,
} from 'src/lib/embeddingSpend';
import {
  principalFromAuthUser,
  type RequestPrincipal,
} from 'src/lib/principals';
import { toStoredToolContext } from 'src/lib/toolContext';
import { readWritePrecondition } from 'src/lib/writePrecondition';
import { recordAuthorizationDecision } from 'src/middleware/audit';

/**
 * Throws an actionable `API_KEY_PROJECT_SCOPE` error when a project-scoped
 * credential explicitly targets a different project than the one it is bound
 * to. This binding is enforced independently of the owner's role: an
 * admin-owned key is confined to its own project like any other.
 *
 * The denial is recorded before it is thrown. This check short-circuits ahead
 * of `resolveProjectIds`, so the audit wrapper never observes it — without the
 * explicit record a cross-project refusal would leave no audit entry at all.
 *
 * No-op when the credential is unscoped or the project matches.
 *
 * `null` is a *target*, not an absence: the request names no project at all —
 * minting or managing an unscoped key. A confined credential must be refused
 * there too, or the boundary is one `POST /api-keys` deep. A route with
 * nothing to check should not call this.
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
 * mapped-but-empty association satisfies this type; one *missing the field
 * altogether* — because a mapper named it `projectId`, or forgot it — does not,
 * and fails to typecheck at the helper boundary.
 *
 * `project_id?: string` would accept both: the object type-checks, the value
 * is `undefined` at runtime, and the authorization call reaches the DB with an
 * undefined `WHERE` binding. Excess-property checking does not cover it, since
 * the object is passed as a variable.
 *
 * Intersect it into the resource shape a permission helper accepts.
 */
/**
 * A `tool_context` bag off a request body, where `null` clears a stored bag: a
 * non-string value is `400` (`toStoredToolContext`), and the keys are left
 * exactly as the caller wrote them, for the key check in `toolContext.ts` to
 * accept or reject (`.claude/rules/case-convention.md`: a bag's keys are never
 * rewritten).
 *
 * Every route reads the field through this or {@link parseToolContextBody}
 * (`toolContextBodyContract.test.ts`), so a malformed bag is refused before any
 * work is queued: two entry points that disagree about what a malformed bag
 * means is how one of them ends up failing open.
 */
export const parseNullableToolContextBody = (
  raw: unknown
): Record<string, string> | null | undefined => {
  return toStoredToolContext(raw);
};

/** {@link parseNullableToolContextBody} where `null` means no bag. */
export const parseToolContextBody = (
  raw: unknown
): Record<string, string> | undefined => {
  return parseNullableToolContextBody(raw) ?? undefined;
};

export type ProjectOwned = { project_id: string | undefined };

/**
 * The only reader of the paging parameters off a query string. An absent or
 * empty `limit` is `undefined`, so the list's default applies; anything but an
 * integer literal is `VALIDATION_FAILED`. Range and ceiling are
 * `resolveLimit`'s, the cursor's meaning `paginatedList`'s.
 */
export const parsePagination = (
  ctx: Context
): { limit?: number; cursor?: string } => {
  const { limit, cursor } = ctx.query;
  if (Array.isArray(cursor)) {
    throw new DomainError('VALIDATION_FAILED', 'cursor must be one string.', {
      field: 'cursor',
    });
  }
  if (limit === undefined || limit === '') {
    return { cursor: cursor || undefined };
  }
  if (typeof limit !== 'string' || !/^-?\d+$/.test(limit.trim())) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `limit must be an integer; got ${JSON.stringify(limit)}.`,
      { field: 'limit' }
    );
  }
  return { limit: Number(limit), cursor: cursor || undefined };
};

/**
 * A resource a route already authorized, past the `null` its lib lookup
 * declares for callers with a wider scope. A miss here is a delete racing the
 * request, answered as the resource being gone.
 */
export const requireFound = <T>(args: {
  value: T | null;
  label: string;
  id: string;
}): T => {
  if (!args.value) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `${args.label} '${args.id}' not found.`
    );
  }
  return args.value;
};

/** A `Context` past {@link requireAuth}: `authUser` is guaranteed present. */
export type AuthenticatedContext = Context & { authUser: AuthUser };

/**
 * Asserts the request is authenticated, throwing `UNAUTHORIZED` otherwise.
 *
 * Declared as a TypeScript **assertion** rather than a function returning the
 * user, so a bare `requireAuth(ctx);` narrows `ctx.authUser` for the rest of
 * the block. Nothing has to thread a returned value around and no
 * `ctx.authUser!` assertion is needed: a handler that forgets the guard does
 * not typecheck. (An assertion signature needs an explicitly annotated call
 * target, hence the type-then-implementation form.)
 *
 * Prefer {@link resolveReadProjectIds} / {@link resolveWriteProjectId}, which
 * run this themselves. It stands alone only where a handler has no project to
 * resolve (`/users/me`, OAuth introspection, sub-resource routes that
 * authorize against a parent they load first).
 */
export const requireAuth: (
  ctx: Context
) => asserts ctx is AuthenticatedContext = (ctx) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }
};

/**
 * An admin acting through a credential that carries no boundary of its own: a
 * login token, or a key bound to no project and narrowed by no policy. Every
 * project-scoped JWT (OAuth, trigger, run token) carries `prj`, which sets
 * `oauthProjectPublicId`.
 */
export const isUnrestrictedAdmin = (authUser: AuthUser): boolean => {
  if (authUser.role !== 'admin') return false;
  if (authUser.apiKeyPublicId !== undefined) {
    return authUser.isControlPlaneKey === true;
  }
  return authUser.oauthProjectPublicId === undefined;
};

/**
 * Gates a global (non-project-scoped) admin operation — users, policies,
 * project creation, the price book — on {@link isUnrestrictedAdmin}: no policy
 * can grant it, and a credential narrowed by project, policies or consent
 * cannot reach it even when its user is an admin. Throws
 * `UNAUTHORIZED`/`FORBIDDEN`.
 *
 * Records the decision for the audit log via `recordAuthorizationDecision` —
 * this comparison bypasses `isAllowed`/`resolveProjectIds` entirely, so
 * without this call the request produces no audit entry at all, even on a
 * successful mutation.
 */
export const requireAdmin = (ctx: Context, action: string): void => {
  requireAuth(ctx);

  const allowed = isUnrestrictedAdmin(ctx.authUser);
  recordAuthorizationDecision(ctx, { action, allowed });

  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
};

/**
 * Gates an admin operation on one project: the caller's role is `admin`, its
 * credential is bound to this project or to none, and its own boundary
 * (key policies, OAuth consent) allows the action there. Throws
 * `UNAUTHORIZED`/`API_KEY_PROJECT_SCOPE`/`FORBIDDEN`.
 */
export const requireProjectAdmin = async (args: {
  ctx: Context;
  projectPublicId: string;
  action: string;
}): Promise<void> => {
  const { ctx, projectPublicId, action } = args;
  requireAuth(ctx);
  assertCredentialProjectScope({
    ctx,
    requestedProjectPublicId: projectPublicId,
    action,
  });

  const allowed =
    ctx.authUser.role === 'admin' &&
    (await ctx.authUser.isAllowed({
      projectPublicId,
      action,
      resource: `srn:${projectPublicId}:*:*`,
    }));
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
 * project binding, then resolve the project ids the caller may read.
 *
 * `undefined` means "no project filter" — a JWT admin with no explicit
 * `project_id` — which lib list/get functions already treat that way, so the
 * return type passes straight through.
 *
 * Every non-admin read route funnels through here. Per-module `check*Access`
 * clones differ only in a `resourceType` literal, so a route reaching the
 * variant *without* `assertCredentialProjectScope` hands a scoped key an opaque
 * `Forbidden`. With one preamble there is no second variant to pick.
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
 * `resolveReadProjectIds` lets `[]` through because "the caller may read zero
 * projects" is a correct answer for a list route — the filter matches nothing
 * and the response is `[]`. A route that fetches one resource and checks
 * whether its project is in the caller's set cannot use that answer: an empty
 * set would make the resource look *missing* rather than *forbidden*, turning
 * an authorization failure into a `404`.
 *
 * `undefined` still means unrestricted and stays permitted; only a non-null,
 * zero-length array is rejected. Getting that pair backwards is why the check
 * was written out inline 17 times instead of shared.
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
/**
 * The public id of the project a write targets: the explicit one, else the
 * project a scoped credential supplies.
 *
 * Exported because a route that also needs the *public* id — to authorize
 * against an SRN, say — must derive it the same way `resolveWriteProjectId`
 * does; a second copy of the implicit-project rule is how the two would drift.
 */
export const resolveWriteProjectPublicId = (args: {
  ctx: Context;
  projectPublicId?: string;
}): string => {
  const { ctx } = args;
  requireAuth(ctx);

  const projectPublicId =
    args.projectPublicId ??
    ctx.authUser.apiKeyProjectPublicId ??
    ctx.authUser.oauthProjectPublicId;

  if (!projectPublicId) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required');
  }

  return projectPublicId;
};

export const resolveWriteProjectId = async (args: {
  ctx: Context;
  projectPublicId?: string;
  action: string;
  resourceType?: string;
}): Promise<number> => {
  const { ctx, action } = args;
  requireAuth(ctx);

  const projectPublicId = resolveWriteProjectPublicId({
    ctx,
    projectPublicId: args.projectPublicId,
  });

  // An actionable error rather than the opaque `Forbidden` `resolveProjectIds`
  // would yield. `projectPublicId` already defaulted to the credential's own
  // project, so this only fires on an explicit, mismatching id.
  assertCredentialProjectScope({
    ctx,
    requestedProjectPublicId: projectPublicId,
    action,
  });

  // Given the truthy `projectPublicId` guaranteed above, every
  // `resolveProjectIds` returns either null (→ 403) or a single-element array,
  // so the resolved id is always defined here.
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

/**
 * The project a caller's embedding is billed to, among `scope`: the first, by
 * public id, the caller may spend embeddings on. A credential bound to one
 * project resolves to it. `undefined` scope is an admin's unrestricted search,
 * which names no project; an empty scope embeds over nothing.
 */
export const resolveEmbeddingSpendProjectId = async (args: {
  ctx: Context;
  scope: number[] | undefined;
}): Promise<number | null> => {
  const { ctx, scope } = args;
  requireAuth(ctx);
  if (scope === undefined || scope.length === 0) return null;

  const spendable = await ctx.authUser.resolveProjectIds(EMBEDDING_SPEND);
  const candidates =
    spendable === undefined
      ? scope
      : scope.filter((id) => {
          return spendable?.includes(id) ?? false;
        });
  if (candidates.length === 0) {
    throw new DomainError(
      'FORBIDDEN',
      `Embedding the query is billed to a project, and the caller holds ${EMBEDDING_SPEND.action} on none in scope.`
    );
  }
  return firstProjectByPublicId({ projectIds: candidates });
};

export type { RequestPrincipal } from 'src/lib/principals';

/**
 * The principal to credit for an action, resolved from the auth context only —
 * never from a body. Attribution that a caller cannot address is the whole
 * point, so the derivation lives here rather than per handler.
 *
 * The rule itself is `principalFromAuthUser`, shared with the audit middleware
 * and task transitions; this is just the `ctx` adapter for it.
 */
export const requestPrincipalFromCtx = (ctx: Context): RequestPrincipal => {
  return principalFromAuthUser(ctx.authUser!);
};

/**
 * A repeatable query parameter's values, checked against the enum the column
 * holds.
 *
 * Fail-closed on every value, empty string included: an unset client-side
 * variable interpolates to nothing, and answering `?status=` with the whole
 * listing hands back the full scan a status filter exists to avoid.
 */
export const parseEnumListQuery = <T extends string>(args: {
  ctx: Context;
  name: string;
  allowed: readonly T[];
}): T[] | undefined => {
  const raw = args.ctx.query[args.name];
  if (raw === undefined) return undefined;

  const allowed: readonly string[] = args.allowed;
  const isAllowed = (value: string): value is T => {
    return allowed.includes(value);
  };
  const values = Array.isArray(raw) ? raw : [raw];
  const unknown = values.filter((value) => {
    return !isAllowed(value);
  });
  if (unknown.length > 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `\`${args.name}\` accepts only ${args.allowed.join(', ')} — ` +
        `received ${unknown
          .map((v) => {
            return `'${v}'`;
          })
          .join(', ')}`,
      { parameter: args.name, allowed: [...args.allowed], invalid: unknown }
    );
  }

  return [...new Set(values.filter(isAllowed))];
};

/**
 * A single-valued query parameter, checked against the enum the column holds.
 * Refused as `parseEnumListQuery` refuses, and also when repeated: the filter
 * names one value, and keeping either would silently drop the other.
 */
export const parseEnumQuery = <T extends string>(args: {
  ctx: Context;
  name: string;
  allowed: readonly T[];
}): T | undefined => {
  const values = parseEnumListQuery(args);
  if (values === undefined) return undefined;
  if (values.length > 1) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `\`${args.name}\` takes one value — received ${values.length}`,
      { parameter: args.name, allowed: [...args.allowed] }
    );
  }
  return values[0];
};

/**
 * One end of a time-range filter (`from`, `to`, `expires_to`), as a `Date`.
 *
 * Absent is not invalid: an unsupplied bound is simply not applied. A supplied
 * unparseable one throws — it must never widen a query into "every row"
 * without the caller knowing.
 */
export const parseDateQuery = (args: {
  ctx: Context;
  name: string;
}): Date | undefined => {
  const value = args.ctx.query[args.name];
  if (Array.isArray(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `'${args.name}' is one bound and takes one value.`,
      { parameter: args.name }
    );
  }
  if (value === undefined || value.length === 0) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `'${args.name}' is not a valid ISO 8601 date: '${value}'.`,
      { parameter: args.name }
    );
  }
  return date;
};

/**
 * The version a write states it is changing, read off the request.
 *
 * Every write on a resource carrying a `version` counter passes its result to
 * that resource's update function; `writePreconditionContract.test.ts` holds
 * the set closed, so a new versioned resource cannot quietly ship without
 * optimistic concurrency. The parsing itself is transport-agnostic and lives in
 * `lib/writePrecondition.ts`.
 */
export const writePreconditionOf = (ctx: Context): number | null => {
  return readWritePrecondition({
    headers: ctx.headers,
    body: ctx.request?.body,
  });
};
