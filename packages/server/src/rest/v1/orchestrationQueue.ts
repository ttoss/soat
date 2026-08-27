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
const mapQueueStats = (stats: QueueStats) => {
  return {
    driver: stats.driver,
    queue_depth: stats.queueDepth,
    claimed_tasks: stats.claimedTasks,
    oldest_queued_age_seconds: stats.oldestQueuedAgeSeconds,
    claim_latency_ms: {
      p50: stats.claimLatencyMs.p50,
      p95: stats.claimLatencyMs.p95,
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
    ctx.body = mapQueueStats(
      await getOrchestrationQueueDriver().stats({
        projectIds: projectIds ?? undefined,
      })
    );
  }
);
