import createDebug from 'debug';

import type { Context } from '../Context';
import { DomainError } from '../errors';
import { evaluateRequestQuotas } from '../lib/quotaEnforcement';

const log = createDebug('soat:quotas');

type Next = () => Promise<void>;

/**
 * Request-quota middleware. Mounted after `auth` and before the route handlers
 * so the counted identity is known and no handler work is wasted on a blocked
 * request.
 *
 * Counts **API-key-authenticated requests only** (v1). JWT-user requests are
 * never counted or blocked — interactive users are not the runaway surface, and
 * exempting them removes the pre-handler project-resolution problem (a project
 * key binds to exactly one project) and the admin-lockout hazard. Unscoped keys
 * (no bound project) are skipped: a `requests` quota is always project-scoped.
 *
 * Fails **open** on infrastructure error: a counter write that itself errors is
 * logged loudly and the request proceeds. "Fail closed" refers to breach
 * semantics (any breached enforce quota blocks), not DB errors — a quota is
 * cost control, not authorization.
 */
export const quotaMiddleware = async (ctx: Context, next: Next) => {
  const authUser = ctx.authUser;
  const shouldCount =
    ctx.path.startsWith('/api/v1') &&
    authUser?.apiKeyPublicId != null &&
    authUser.apiKeyProjectId != null;

  if (!shouldCount) {
    await next();
    return;
  }

  const breach = await evaluateRequestQuotas({
    projectId: authUser!.apiKeyProjectId!,
    apiKeyPublicId: authUser!.apiKeyPublicId!,
  }).catch((error: unknown) => {
    // Fail open — never let a counter write failure take down live traffic.
    log('quotaMiddleware: failing open on counter error %O', error);
    return null;
  });

  if (breach) {
    ctx.set('Retry-After', String(breach.retryAfter));
    throw new DomainError(
      'QUOTA_EXCEEDED',
      `Quota exceeded for ${breach.scope}${
        breach.scopeRef ? ` ${breach.scopeRef}` : ''
      }.`,
      // Error responses bypass the caseTransform middleware, so meta keys are
      // written in snake_case to match the external REST contract.
      {
        quota_id: breach.quotaId,
        metric: breach.metric,
        limit: breach.limit,
        window: breach.window,
        resets_at: breach.resetsAt.toISOString(),
      }
    );
  }

  await next();
};
