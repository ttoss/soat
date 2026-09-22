import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { listActivity } from 'src/lib/activity';
import { streamActivityNdjson } from 'src/lib/activityExport';

import { requireAuth, resolveReadProjectIds } from './helpers';
import { sendNdjson } from './ndjsonResponse';

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
    agentId: ctx.query.agent_id as string | undefined,
    generationId: ctx.query.generation_id as string | undefined,
    orchestrationRunId: ctx.query.orchestration_run_id as string | undefined,
    cursor: ctx.query.cursor as string | undefined,
    limit,
  });
});

activityRouter.get('/activity/export', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  // Per-project, as every export is.
  if (!projectPublicId) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required');
  }

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'activity:ExportActivity',
    resourceType: 'activity',
  });

  sendNdjson({
    ctx,
    filename: `activity-${projectPublicId}.ndjson`,
    lines: streamActivityNdjson({
      projectIds: projectIds ?? [],
      kind: ctx.query.kind as string | undefined,
      severity: ctx.query.severity as string | undefined,
      agentId: ctx.query.agent_id as string | undefined,
      generationId: ctx.query.generation_id as string | undefined,
      orchestrationRunId: ctx.query.orchestration_run_id as string | undefined,
    }),
  });
});

export { activityRouter };
