import createDebug from 'debug';

import type { AuthUser, Context } from '../Context';
import { DomainError } from '../errors';
import type { AuditPrincipalType } from '../lib/auditLog';
import { peekReadAuditEnabled } from '../lib/auditLog';
import { enqueueAuditWrite } from '../lib/auditQueue';

const log = createDebug('soat:audit');

/** A route-supplied hint for an item-scoped mutation's target project/resource. */
export type AuditResourceHint = {
  projectPublicId: string;
  resourceSrn?: string;
  resourcePublicId?: string;
};

/**
 * Lets a route hand the audit middleware the project/resource it resolved for
 * an item-scoped mutation authorized via `resolveProjectIds` with no explicit
 * `projectPublicId` (see {@link instrumentAuthUser}). Needed specifically for
 * routes whose success response carries no resource body to backfill from
 * (e.g. a `204 No Content` delete) — call it once the route has looked up the
 * resource, before performing the mutation.
 */
export const setAuditResourceHint = (
  ctx: Context,
  hint: AuditResourceHint
): void => {
  ctx.state = ctx.state ?? {};
  ctx.state.auditResource = hint;
};

type Next = () => Promise<void>;

/** One authorization decision captured during a request. */
type RecordedCheck = {
  action: string;
  resource: string | null;
  projectPublicId?: string;
  resourceType?: string | null;
  allowed: boolean;
};

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Wraps `authUser.isAllowed` and `authUser.resolveProjectIds` so every
 * route-level authorization decision is recorded onto `checks`.
 *
 * Only route-level checks are captured: `resolveProjectIds` builds its internal
 * list-scoping `isAllowed` calls from the *unwrapped* function it closed over
 * when `authMiddleware` built `authUser`, so wrapping the public `isAllowed`
 * here never sees them.
 *
 * The `resolveProjectIds` wrapper records two shapes:
 * - an explicit `projectPublicId` — the create/write path (type-level SRN
 *   `soat:{project}:{type}:*`).
 * - no `projectPublicId` on a *mutating* method — an item-scoped `PATCH`/
 *   `DELETE`/etc. that authorizes against the caller's allowed project set
 *   before the target resource (and its real project) is resolved deeper in
 *   the lib layer. The project and precise SRN are not known yet here;
 *   `recordEntry` recovers them once the handler has run (see
 *   {@link recoverMissingProject}).
 *
 * A no-`projectPublicId` call on a `GET` is the unscoped list-enumeration path
 * and is deliberately left unrecorded so the log is never flooded with
 * read-scoping noise.
 */
const instrumentAuthUser = (
  authUser: AuthUser,
  checks: RecordedCheck[],
  method: string
): void => {
  const originalIsAllowed = authUser.isAllowed;
  authUser.isAllowed = async (reqArgs) => {
    const allowed = await originalIsAllowed(reqArgs);
    checks.push({
      action: reqArgs.action,
      resource: reqArgs.resource ?? null,
      projectPublicId: reqArgs.projectPublicId,
      allowed,
    });
    return allowed;
  };

  const originalResolveProjectIds = authUser.resolveProjectIds;
  authUser.resolveProjectIds = async (reqArgs) => {
    const result = await originalResolveProjectIds(reqArgs);
    if (reqArgs.projectPublicId) {
      const type = reqArgs.resourceType ?? '*';
      checks.push({
        action: reqArgs.action,
        resource: `soat:${reqArgs.projectPublicId}:${type}:*`,
        projectPublicId: reqArgs.projectPublicId,
        resourceType: reqArgs.resourceType ?? null,
        allowed: result !== null,
      });
    } else if (MUTATING_METHODS.has(method)) {
      checks.push({
        action: reqArgs.action,
        resource: null,
        projectPublicId: undefined,
        resourceType: reqArgs.resourceType ?? null,
        allowed: result !== null,
      });
    }
    return result;
  };
};

/**
 * Selects the primary check for the entry. On a `403` the denied pair is primary
 * — it is the check that actually blocked the request, so labeling the entry
 * with an earlier *allowed* action would misattribute the denial. Otherwise the
 * first recorded check is primary: it is the route's own permission check, made
 * before any mutation.
 */
const selectPrimaryIndex = (
  checks: RecordedCheck[],
  status: number
): number => {
  if (status === 403) {
    const deniedIndex = checks.findIndex((c) => {
      return !c.allowed;
    });
    if (deniedIndex >= 0) return deniedIndex;
  }
  return 0;
};

const deriveResourcePublicId = (args: {
  resourceSrn: string | null;
  status: number;
  body: unknown;
}): string | null => {
  const last = args.resourceSrn ? args.resourceSrn.split(':').pop() : undefined;
  if (last && last !== '*') return last;

  // Creates authorize before the resource exists (type-level SRN ending in
  // `*`), so the id is captured from the response body on success instead.
  const ok = args.status >= 200 && args.status < 300;
  if (
    ok &&
    args.body &&
    typeof args.body === 'object' &&
    !Array.isArray(args.body)
  ) {
    const id = (args.body as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
};

/**
 * Recovers the project (and, where present, the resource id) for an
 * item-scoped mutation whose `resolveProjectIds` check ran with no
 * `projectPublicId` (see {@link instrumentAuthUser}). The response body is the
 * only place that project surfaces: on success, mapped resources always
 * include `project_id` (the external, already snake_cased contract — this
 * runs inside `restRouter` and therefore
 * unwinds *before* this middleware's `finally` block reads `ctx.body`).
 */
const backfillFromResponseBody = (
  body: unknown
): { projectPublicId: string; resourcePublicId: string | null } | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const projectId = (body as { project_id?: unknown }).project_id;
  if (typeof projectId !== 'string') return null;
  const id = (body as { id?: unknown }).id;
  return {
    projectPublicId: projectId,
    resourcePublicId: typeof id === 'string' ? id : null,
  };
};

/**
 * Best-effort resource id for a request whose project could not be recovered
 * at all (e.g. a denied item-scoped mutation, whose response body carries no
 * resource fields). Route path params are unnamed here — the middleware is
 * generic across every route — so this only applies when the route has
 * exactly one path param, the common shape for `/<resource>/:id`-style
 * routes; multi-param routes (nested sub-resources) are left unresolved
 * rather than guessing which segment is "the" resource.
 */
const deriveTargetIdFromParams = (ctx: Context): string | null => {
  const params = ctx.params as Record<string, unknown> | undefined;
  if (!params) return null;
  const values = Object.values(params).filter((v) => {
    return typeof v === 'string';
  });
  return values.length === 1 ? (values[0] as string) : null;
};

const resolvePrincipal = (
  authUser: AuthUser
): { principalType: AuditPrincipalType; principalId: string } => {
  if (authUser.apiKeyPublicId) {
    return { principalType: 'api_key', principalId: authUser.apiKeyPublicId };
  }
  return { principalType: 'user', principalId: authUser.publicId };
};

const buildDetail = (
  additional: RecordedCheck[]
): Record<string, unknown> | null => {
  if (additional.length === 0) return null;
  return {
    additionalChecks: additional.map((c) => {
      return { action: c.action, resource: c.resource, allowed: c.allowed };
    }),
  };
};

/**
 * Whether this request should produce an entry at all.
 *
 * Mutations always do. Reads only do when the project they name has opted into
 * read auditing — so a read that names no project is never recorded, since no
 * project could opt it in. The cached flag is consulted here to keep the
 * high-volume read path off the queue entirely; on a cache miss the entry is
 * enqueued and `writeAuditEntry` makes the authoritative decision, so the
 * opt-in is never missed for the sake of a cold cache.
 */
const shouldRecord = (args: {
  method: string;
  checks: RecordedCheck[];
}): boolean => {
  if (args.checks.length === 0) return false;
  if (MUTATING_METHODS.has(args.method)) return true;

  const projectPublicId = args.checks.find((c) => {
    return c.projectPublicId;
  })?.projectPublicId;
  if (!projectPublicId) return false;

  return peekReadAuditEnabled(projectPublicId) !== false;
};

type RecoveredTarget = {
  projectPublicId: string;
  resourceSrn: string | null;
  resourcePublicIdHint: string | null;
};

/**
 * Recovers the project for a check that carried none (see
 * `instrumentAuthUser`), in order of precedence: a route-supplied hint (see
 * {@link setAuditResourceHint}) — needed for routes whose success response
 * has no body to read, e.g. a `204` delete — then the response body (mapped
 * resources always echo `project_id`). Returns `null` when neither source
 * resolves anything.
 */
const recoverMissingProject = (ctx: Context): RecoveredTarget | null => {
  const stateHint = ctx.state?.auditResource as AuditResourceHint | undefined;
  if (stateHint) {
    return {
      projectPublicId: stateHint.projectPublicId,
      resourceSrn: stateHint.resourceSrn ?? null,
      resourcePublicIdHint: stateHint.resourcePublicId ?? null,
    };
  }

  const backfilled = backfillFromResponseBody(ctx.body);
  if (backfilled) {
    return {
      projectPublicId: backfilled.projectPublicId,
      resourceSrn: null,
      resourcePublicIdHint: backfilled.resourcePublicId,
    };
  }

  return null;
};

/**
 * Resolves the project, resource SRN, and resource id for the primary check.
 * Extracted (with {@link recoverMissingProject}) so `recordEntry` stays under
 * the cyclomatic-complexity limit.
 */
const resolveEntryTarget = (
  ctx: Context,
  primary: RecordedCheck
): {
  projectPublicId: string | null;
  resourceSrn: string | null;
  resourcePublicIdHint: string | null;
} => {
  let projectPublicId = primary.projectPublicId ?? null;
  let resourceSrn = primary.resource;
  let resourcePublicIdHint: string | null = null;

  if (!projectPublicId) {
    const recovered = recoverMissingProject(ctx);
    if (recovered) {
      projectPublicId = recovered.projectPublicId;
      resourceSrn = resourceSrn ?? recovered.resourceSrn;
      resourcePublicIdHint = recovered.resourcePublicIdHint;
    }
  }

  resourcePublicIdHint = resourcePublicIdHint ?? deriveTargetIdFromParams(ctx);

  if (!resourceSrn && projectPublicId) {
    const type = primary.resourceType ?? '*';
    resourceSrn = `soat:${projectPublicId}:${type}:${resourcePublicIdHint ?? '*'}`;
  }

  return { projectPublicId, resourceSrn, resourcePublicIdHint };
};

/** Builds and enqueues the audit entry for a completed request. */
const recordEntry = (
  ctx: Context,
  checks: RecordedCheck[],
  status: number
): void => {
  const primaryIndex = selectPrimaryIndex(checks, status);
  const primary = checks[primaryIndex];
  const additional = checks.filter((_, i) => {
    return i !== primaryIndex;
  });

  const { principalType, principalId } = resolvePrincipal(ctx.authUser!);
  const { projectPublicId, resourceSrn, resourcePublicIdHint } =
    resolveEntryTarget(ctx, primary);

  enqueueAuditWrite({
    projectPublicId,
    principalType,
    principalId,
    action: primary.action,
    resourceSrn,
    resourcePublicId:
      resourcePublicIdHint ??
      deriveResourcePublicId({
        resourceSrn,
        status,
        body: ctx.body,
      }),
    status,
    requestId: ctx.state?.requestId ?? null,
    ip: ctx.ip ?? null,
    userAgent: ctx.headers?.['user-agent'] ?? null,
    detail: buildDetail(additional),
    isRead: !MUTATING_METHODS.has(ctx.method),
  });
};

/**
 * Audit-log write hook. Mounted after `authMiddleware` (so `authUser` and its
 * `isAllowed` are attached) and wrapping the route handlers (so the response
 * status and body are final when it writes). Records one entry per mutating
 * `/api/v1` request that performed an authorization check, post-commit, through
 * the fire-and-forget queue — auditing never blocks or fails the request it
 * describes.
 *
 * Read (`GET`) requests write nothing unless the project they name has opted in
 * via `audit_reads_enabled`; requests that made no authorization check (e.g.
 * bootstrap/login) are skipped.
 */
export const auditMiddleware = async (ctx: Context, next: Next) => {
  if (!ctx.path.startsWith('/api/v1') || !ctx.authUser) {
    await next();
    return;
  }

  const checks: RecordedCheck[] = [];
  instrumentAuthUser(ctx.authUser, checks, ctx.method);

  // The status recorded is the final one. On a thrown error the outer error
  // middleware sets `ctx.status` *after* this middleware unwinds, so the status
  // is derived from the error here instead (same mapping the error middleware
  // uses), letting failed mutations — including thrown denials — be audited.
  let errorStatus: number | null = null;
  try {
    await next();
  } catch (error) {
    errorStatus = error instanceof DomainError ? error.httpStatus : 500;
    throw error;
  } finally {
    if (shouldRecord({ method: ctx.method, checks })) {
      try {
        const status =
          errorStatus ?? (typeof ctx.status === 'number' ? ctx.status : 0);
        recordEntry(ctx, checks, status);
      } catch (recordError) {
        // The write hook must never throw into the request it describes; guard
        // defensively so a malformed entry can't turn a 200 into a 500.
        log('auditMiddleware: recordEntry failed %o', recordError);
      }
    }
  }
};
