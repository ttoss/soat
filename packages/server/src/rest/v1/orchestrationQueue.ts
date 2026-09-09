import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { getOrchestrationQueueDriver } from 'src/lib/orchestration-queue-drivers';
import type { QueueStats } from 'src/lib/orchestration-queue-drivers/types';

import { requireAuth, requireProjectAccess } from './helpers';

/**
 * The wire projection of a `QueueStats` snapshot. The driver type stays
 * camelCase — it is the internal contract both the postgres and SQS drivers
 * implement, held to it by the shared conformance suite — so the conversion
 * happens here, at the one place a snapshot reaches a client.
 */
const mapQueueStats = (args: { stats: QueueStats; restricted: boolean }) => {
  const { stats, restricted } = args;
  // A restricted principal is answered about its own scope only. `perProject`
  // is already scoped by the driver, so the two totals are summed from it; the
  // oldest-task age and the claim-latency ring describe the whole deployment
  // and cannot be narrowed, so they are withheld rather than approximated —
  // reporting another tenant's backlog to this one is the leak being closed.
  const scopedDepth = stats.perProject.reduce((total, entry) => {
    return total + entry.queued;
  }, 0);
  const scopedClaimed = stats.perProject.reduce((total, entry) => {
    return total + entry.claimed;
  }, 0);

  return {
    driver: stats.driver,
    queue_depth: restricted ? scopedDepth : stats.queueDepth,
    claimed_tasks: restricted ? scopedClaimed : stats.claimedTasks,
    oldest_queued_age_seconds: restricted ? null : stats.oldestQueuedAgeSeconds,
    claim_latency_ms: {
      p50: restricted ? null : stats.claimLatencyMs.p50,
      p95: restricted ? null : stats.claimLatencyMs.p95,
      window_seconds: stats.claimLatencyMs.windowSeconds,
    },
    per_project: stats.perProject.map((entry) => {
      return {
        project_id: entry.projectId,
        queued: entry.queued,
        claimed: entry.claimed,
      };
    }),
  };
};

// A separate router so the main orchestrations one stays within its size
// budget. `queue/stats` has three path segments, so it never collides with the
// two-segment `/orchestrations/:id` regardless of mount order.
export const orchestrationQueueRouter = new Router<Context>();

/**
 * @openapi
 * /api/v1/orchestrations/queue/stats:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1queue~1stats/get'
 */
orchestrationQueueRouter.get(
  '/orchestrations/queue/stats',
  async (ctx: Context) => {
    requireAuth(ctx);
    // An empty scope — the action granted on no project — is forbidden for this
    // operator endpoint, not an empty result, so this takes the stricter of the
    // two preambles.
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'orchestrations:GetQueueStats',
      resourceType: 'orchestration',
    });
    ctx.body = mapQueueStats({
      stats: await getOrchestrationQueueDriver().stats({
        projectIds: projectIds ?? undefined,
      }),
      restricted: projectIds !== null && projectIds !== undefined,
    });
  }
);
