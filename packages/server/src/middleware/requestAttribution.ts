import createDebug from 'debug';

import type { AuthUser, Context } from '../Context';
import {
  evaluateRequestQuotas,
  quotaBreachError,
} from '../lib/quotaEnforcement';
import { incrementRequestCount } from '../lib/usageRequests';

const log = createDebug('soat:quotas');

type Next = () => Promise<void>;

/**
 * Attributes one served request to a project: meters it (`api_request` usage)
 * and evaluates that project's `requests` quotas, throwing `QUOTA_EXCEEDED`
 * when an `enforce` quota is breached.
 *
 * Metering runs **before** the quota check so a request a quota blocks is still
 * counted — the meter records arrivals, the quota decides admissions, and the
 * two must not disagree about how many requests arrived.
 *
 * Idempotent per request: the first call wins and later ones are no-ops, so a
 * handler that authorizes twice (a write plus a privilege-escalation probe) is
 * counted once. `ctx.state` is guaranteed to exist here — `requestIdMiddleware`
 * initializes it before any of this runs.
 *
 * Fails **open** on infrastructure error: a counter write that itself errors is
 * logged loudly and the request proceeds. "Fail closed" refers to breach
 * semantics (any breached enforce quota blocks), not DB errors — a quota is
 * cost control, not authorization.
 */
export const attributeRequestToProject = async (args: {
  ctx: Context;
  projectId: number;
  apiKeyPublicId: string;
}): Promise<void> => {
  const { ctx } = args;

  if (ctx.state.requestAttributed) return;
  ctx.state.requestAttributed = true;

  // Disabled with `USAGE_REQUEST_METERING_DISABLED` so counters never grow
  // while the flush scheduler is off. Quota enforcement is independent of it.
  if (process.env.USAGE_REQUEST_METERING_DISABLED !== 'true') {
    incrementRequestCount({
      projectId: args.projectId,
      apiKeyPublicId: args.apiKeyPublicId,
    });
  }

  const breach = await evaluateRequestQuotas({
    projectId: args.projectId,
    apiKeyPublicId: args.apiKeyPublicId,
  }).catch((error: unknown) => {
    // Fail open — never let a counter write failure take down live traffic.
    log('attributeRequestToProject: failing open on counter error %O', error);
    return null;
  });

  if (breach) {
    ctx.set('Retry-After', String(breach.retryAfter));
    throw quotaBreachError(breach);
  }
};

/**
 * Defers attribution for an **unscoped** API key (no bound project) until the
 * route itself has resolved *and authorized* a project, by wrapping the two
 * functions every project authorization in this codebase goes through:
 * `isAllowed` (routes that derive their project from a parent resource) and
 * `resolveProjectIds` (routes that take a `project_id`, directly or via
 * `rest/v1/helpers.ts`). Attribution fires on the first **granted** check.
 *
 * Wrapping the authorizer — rather than calling a hook from ~48 route files —
 * is what makes the coverage total and unforgettable: a new route cannot opt
 * out, because it cannot serve project data without passing through one of
 * these two functions first.
 *
 * Two properties make this safe, and both are load-bearing:
 *
 * - **Only granted checks count.** The DoS vector that blocked the naive fix
 *   (see #742) was trusting a client-supplied `project_id`: any key holder
 *   could then burn an unrelated project's `requests` quota by naming its
 *   non-secret public id. Here the project has already passed the route's own
 *   permission check, so a caller can only ever spend a quota it legitimately
 *   holds access to.
 * - **Enumeration probes are invisible.** `resolveProjectIds` builds its
 *   list-scoping `isAllowed` calls from the *unwrapped* function it closed over
 *   when `authMiddleware` assembled `authUser`, so wrapping the public
 *   `isAllowed` here never sees them — the same property `auditMiddleware`
 *   relies on. Without it, a cross-project list would attribute itself to
 *   whichever project the enumeration happened to probe first.
 *
 * A request that resolves to *no single* project — every project (an unscoped
 * admin key with no attached policies and no `project_id` filter) or several —
 * names nothing to count against and stays exempt.
 */
const deferAttributionUntilAuthorized = (args: {
  ctx: Context;
  authUser: AuthUser;
  apiKeyPublicId: string;
}): void => {
  const { ctx, authUser, apiKeyPublicId } = args;

  const attributeByProjectPublicId = async (
    projectPublicId: string
  ): Promise<void> => {
    // Short-circuit before the lookup, not just inside
    // `attributeRequestToProject`: a handler that authorizes twice would
    // otherwise pay for a project query it cannot act on.
    if (ctx.state.requestAttributed) return;

    // The numeric id is what the counter and the quota window are keyed by. A
    // miss means the project was deleted between the route's lookup and now;
    // there is nothing left to meter.
    const project = await ctx.db.Project.findOne({
      where: { publicId: projectPublicId },
      attributes: ['id'],
    });
    if (!project) return;

    await attributeRequestToProject({
      ctx,
      projectId: project.id as number,
      apiKeyPublicId,
    });
  };

  const originalIsAllowed = authUser.isAllowed;
  authUser.isAllowed = async (reqArgs) => {
    const allowed = await originalIsAllowed(reqArgs);
    if (allowed) await attributeByProjectPublicId(reqArgs.projectPublicId);
    return allowed;
  };

  const originalResolveProjectIds = authUser.resolveProjectIds;
  authUser.resolveProjectIds = async (reqArgs) => {
    const result = await originalResolveProjectIds(reqArgs);
    if (result?.length === 1) {
      await attributeRequestToProject({
        ctx,
        projectId: result[0],
        apiKeyPublicId,
      });
    }
    return result;
  };
};

/**
 * Request metering + quota enforcement for `/api/v1`. Mounted after `auth` (the
 * counted identity is known) and after `audit` (so the authorization check that
 * admitted the request is recorded even when a quota then rejects it).
 *
 * Counts **API-key-authenticated requests only** (v1). JWT-user requests are
 * never counted or blocked — interactive users are not the runaway surface, and
 * exempting them removes the admin-lockout hazard.
 *
 * A **project-scoped** key carries its project from the moment it authenticates,
 * so it is attributed here, before routing: no handler work is wasted on a
 * request a quota will reject. An **unscoped** key has no project yet, so
 * attribution is deferred to the route's own authorized resolution — see
 * {@link deferAttributionUntilAuthorized}. That still lands before any mutation,
 * because a handler authorizes before it writes.
 */
export const requestAttributionMiddleware = async (
  ctx: Context,
  next: Next
) => {
  const authUser = ctx.authUser;
  const apiKeyPublicId = authUser?.apiKeyPublicId;

  if (!ctx.path.startsWith('/api/v1') || !authUser || apiKeyPublicId == null) {
    await next();
    return;
  }

  if (authUser.apiKeyProjectId != null) {
    await attributeRequestToProject({
      ctx,
      projectId: authUser.apiKeyProjectId,
      apiKeyPublicId,
    });
  } else {
    deferAttributionUntilAuthorized({ ctx, authUser, apiKeyPublicId });
  }

  await next();
};
