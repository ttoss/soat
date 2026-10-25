import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  ACTIVITY_KINDS,
  ACTIVITY_SEVERITIES,
  type ActivityFilters,
  listActivity,
} from 'src/lib/activity';
import { streamActivityNdjson } from 'src/lib/activityExport';

import {
  parseEnumQuery,
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
} from './helpers';
import { sendNdjson } from './ndjsonResponse';

const activityRouter = new Router<Context>();

/** The filters a caller may add, read once for the feed and its export. */
const readActivityFilters = (
  ctx: Context
): Omit<ActivityFilters, 'projectIds'> => {
  return {
    kind: parseEnumQuery({ ctx, name: 'kind', allowed: ACTIVITY_KINDS }),
    severity: parseEnumQuery({
      ctx,
      name: 'severity',
      allowed: ACTIVITY_SEVERITIES,
    }),
    agentId: ctx.query.agent_id as string | undefined,
    generationId: ctx.query.generation_id as string | undefined,
    orchestrationRunId: ctx.query.orchestration_run_id as string | undefined,
  };
};

activityRouter.get('/activity', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'activity:ListActivity',
    resourceType: 'activity',
  });

  ctx.body = await listActivity({
    projectIds: projectIds ?? [],
    ...readActivityFilters(ctx),
    ...parsePagination(ctx),
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
      ...readActivityFilters(ctx),
    }),
  });
});

export { activityRouter };
