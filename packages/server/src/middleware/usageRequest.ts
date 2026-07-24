import type { Context } from '../Context';
import { incrementRequestCount } from '../lib/usageRequests';

type Next = () => Promise<void>;

/**
 * API-request metering middleware. Mounted after `auth` (so the counted
 * identity is known) and before `quota` (so a request that a quota will block is
 * still counted — mirroring quota's own count-on-arrival semantics).
 *
 * Counts **API-key-authenticated, project-scoped requests only**, exactly like
 * [quota.ts](./quota.ts): JWT-user and unscoped-key requests are never counted.
 * The increment is a pure in-memory map write (no I/O), so it adds no latency;
 * accumulated counts are flushed to `api_request` usage events on an interval by
 * the usage-request scheduler. Disabled with `USAGE_REQUEST_METERING_DISABLED`
 * so counters never grow while the flush scheduler is off.
 */
export const usageRequestMiddleware = async (ctx: Context, next: Next) => {
  const authUser = ctx.authUser;
  const shouldCount =
    process.env.USAGE_REQUEST_METERING_DISABLED !== 'true' &&
    ctx.path.startsWith('/api/v1') &&
    authUser?.apiKeyPublicId != null &&
    authUser.apiKeyProjectId != null;

  if (shouldCount) {
    incrementRequestCount({
      projectId: authUser!.apiKeyProjectId!,
      apiKeyPublicId: authUser!.apiKeyPublicId!,
    });
  }

  await next();
};
