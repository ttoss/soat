import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { getOrchestrationQueueDriver } from 'src/lib/orchestration-queue-drivers';
import type { QueueStats } from 'src/lib/orchestration-queue-drivers/types';

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

// Queue operations for orchestrations live on their own router so the main
// orchestrations router stays within its size budget. The `queue/stats` path
// has three segments, so it never collides with `/orchestrations/:id` (two
// segments) regardless of mount order.
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
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }
    const projectIds = await ctx.authUser.resolveProjectIds({
      action: 'orchestrations:GetQueueStats',
      resourceType: 'orchestration',
    });
    // `null` = forbidden; an empty array = the action is granted on no project,
    // which for this operator endpoint is also forbidden. `undefined` (admin /
    // unscoped) means all projects; a non-empty array means those projects.
    if (
      projectIds === null ||
      (Array.isArray(projectIds) && projectIds.length === 0)
    ) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }
    ctx.body = mapQueueStats(
      await getOrchestrationQueueDriver().stats({
        projectIds: projectIds ?? undefined,
      })
    );
  }
);
