import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { getQueueStats } from 'src/lib/orchestrationQueueStats';

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
    ctx.body = await getQueueStats({ projectIds: projectIds ?? undefined });
  }
);
