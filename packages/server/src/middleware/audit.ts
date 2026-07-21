import createDebug from 'debug';

import type { AuthUser, Context } from '../Context';
import { DomainError } from '../errors';
import type { AuditActorType } from '../lib/auditLog';
import { enqueueAuditWrite } from '../lib/auditQueue';

const log = createDebug('soat:audit');

type Next = () => Promise<void>;

/** One authorization decision captured during a request. */
type RecordedCheck = {
  action: string;
  resource: string | null;
  projectPublicId?: string;
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
 * here never sees them. The `resolveProjectIds` wrapper itself only records when
 * an explicit `projectPublicId` was passed — that is the create/write path
 * (type-level SRN `soat:{project}:{type}:*`); the no-id list-enumeration path is
 * deliberately left unrecorded so the log is never flooded with read-scoping
 * noise.
 */
const instrumentAuthUser = (
  authUser: AuthUser,
  checks: RecordedCheck[]
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

const resolveActor = (
  authUser: AuthUser
): { actorType: AuditActorType; actorId: string } => {
  if (authUser.apiKeyPublicId) {
    return { actorType: 'api_key', actorId: authUser.apiKeyPublicId };
  }
  return { actorType: 'user', actorId: authUser.publicId };
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

/** Builds and enqueues the audit entry for a completed mutating request. */
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

  const { actorType, actorId } = resolveActor(ctx.authUser!);

  enqueueAuditWrite({
    projectPublicId: primary.projectPublicId ?? null,
    actorType,
    actorId,
    action: primary.action,
    resourceSrn: primary.resource,
    resourcePublicId: deriveResourcePublicId({
      resourceSrn: primary.resource,
      status,
      body: ctx.body,
    }),
    status,
    requestId: ctx.state?.requestId ?? null,
    ip: ctx.ip ?? null,
    userAgent: ctx.headers?.['user-agent'] ?? null,
    detail: buildDetail(additional),
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
 * GET requests write nothing (read auditing is out of scope for v1); requests
 * that made no authorization check (e.g. bootstrap/login) are skipped.
 */
export const auditMiddleware = async (ctx: Context, next: Next) => {
  if (!ctx.path.startsWith('/api/v1') || !ctx.authUser) {
    await next();
    return;
  }

  const checks: RecordedCheck[] = [];
  instrumentAuthUser(ctx.authUser, checks);

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
    if (MUTATING_METHODS.has(ctx.method) && checks.length > 0) {
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
