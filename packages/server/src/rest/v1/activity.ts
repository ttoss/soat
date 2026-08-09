import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { listActivity } from 'src/lib/activity';

import { requireAuth, resolveReadProjectIds } from './helpers';

const activityRouter = new Router<Context>();

activityRouter.get('/activity', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'activity:ListActivity',
    resourceType: 'activity',
  });

  const limitRaw = ctx.query.limit as string | undefined;
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;

  ctx.body = await listActivity({
    projectIds: projectIds ?? [],
    kind: ctx.query.kind as string | undefined,
    severity: ctx.query.severity as string | undefined,
    cursor: ctx.query.cursor as string | undefined,
    limit,
  });
});

export { activityRouter };
