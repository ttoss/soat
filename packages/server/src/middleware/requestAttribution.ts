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
 * and evaluates that project's `requests` quotas, throwing `QUOTA_EXCEEDED` on
 * a breached `enforce` quota.
 *
 * Metering runs **before** the quota check so a blocked request is still
 * counted — the meter records arrivals, the quota decides admissions, and the
 * two must not disagree about how many requests arrived.
 *
 * Only one of the two counters gates admission. The meter is an in-memory `Map`
 * increment flushed to usage events on a timer, so there is no promise to
 * await. The quota counter is a row per `(quota, window)` incremented inside
 * the awaited `evaluateRequestQuotas` by one atomic
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING "count"` that is both the
 * increment and the value compared to the limit, so enforcement never evaluates
 * a count missing a predecessor — pinned by the two "under concurrency" tests
 * in `rest/quotas.test.ts` (#1049).
 *
 * Idempotent per request: the first call wins, so a handler that authorizes
 * twice is counted once.
 *
 * Fails **open** on infrastructure error: a counter write that errors is logged
 * and the request proceeds. "Fail closed" refers to breach semantics, not DB
 * errors — a quota is cost control, not authorization.
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
 * Defers attribution for an **unscoped** API key until the route has resolved
 * *and authorized* a project, by wrapping the two functions every project
 * authorization goes through: `isAllowed` and `resolveProjectIds`. Attribution
 * fires on the first **granted** check.
 *
 * Wrapping the authorizer — rather than calling a hook from ~48 route files —
 * is what makes coverage total and unforgettable: a new route cannot serve
 * project data without passing through one of them first.
 *
 * Two properties make it safe, both load-bearing:
 *
 * - **Only granted checks count.** The DoS vector that blocked the naive fix
 *   (#742) was trusting a client-supplied `project_id`: any key holder could
 *   burn an unrelated project's quota by naming its public id. Here the project
 *   has already passed the route's own permission check.
 * - **Enumeration probes are invisible.** `resolveProjectIds` builds its
 *   list-scoping calls from the *unwrapped* `isAllowed`, the same property
 *   `auditMiddleware` relies on; without it a cross-project list would
 *   attribute itself to whichever project the enumeration probed first.
 *
 * A request resolving to no single project — every project, or several — names
 * nothing to count against and stays exempt.
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

    // Sequelize throws on a `WHERE` bound to `undefined`, and not being a
    // `DomainError` it surfaced as a raw 500 on a valid route (#801).
    // `isAllowed` now denies such a check outright, so this is the last line of
    // the same fail-open philosophy the rest of the module applies.
    if (!projectPublicId) {
      log('attributeByProjectPublicId: no projectPublicId — not attributing');
      return;
    }

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
 * counted identity is known) and after `audit` (so the check that admitted the
 * request is recorded even when a quota then rejects it).
 *
 * Counts **API-key-authenticated requests only** (v1). JWT-user requests are
 * never counted or blocked — interactive users are not the runaway surface, and
 * exempting them removes the admin-lockout hazard.
 *
 * A **project-scoped** key is attributed here, before routing, so no handler
 * work is wasted on a request a quota will reject. An **unscoped** key defers to
 * the route's own authorized resolution — see
 * {@link deferAttributionUntilAuthorized} — which still lands before any
 * mutation, because a handler authorizes before it writes.
 *
 * **Run-as tokens are exempt, deliberately.** A background drive continues work
 * whose arrival was already counted; metering it would bill a run's self-calls
 * as fresh client traffic and let a long chain breach the starting key's quota
 * mid-flight. Until #887 the exemption was accidental (`apiKeyPublicId` simply
 * went unset), and the `isRunToken` marker (#885) is what makes it statable
 * without decoding a token here.
 */
export const requestAttributionMiddleware = async (
  ctx: Context,
  next: Next
) => {
  const authUser = ctx.authUser;
  const apiKeyPublicId = authUser?.apiKeyPublicId;

  if (
    !ctx.path.startsWith('/api/v1') ||
    !authUser ||
    apiKeyPublicId == null ||
    authUser.isRunToken
  ) {
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
