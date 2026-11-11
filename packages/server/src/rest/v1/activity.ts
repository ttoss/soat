import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  ACTIVITY_KINDS,
  ACTIVITY_SEVERITIES,
  type ActivityFilters,
  listActivity,
} from 'src/lib/activity';
import { streamActivityNdjson } from 'src/lib/activityExport';

import { parseEnumQuery, parsePagination, requireAuth } from './helpers';
import { resolveListScope } from './listScope';
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

  const { projectIds } = await resolveListScope({
    ctx,
    action: 'activity:ListActivity',
    resourceType: 'activity',
    projectSelector: 'optional',
  });

  ctx.body = await listActivity({
    projectIds,
    ...readActivityFilters(ctx),
    ...parsePagination(ctx),
  });
});

activityRouter.get('/activity/export', async (ctx: Context) => {
  requireAuth(ctx);

  // Per-project, as every export is.
  const { projectIds, projectPublicId } = await resolveListScope({
    ctx,
    action: 'activity:ExportActivity',
    resourceType: 'activity',
    projectSelector: 'required',
  });

  sendNdjson({
    ctx,
    filename: `activity-${projectPublicId}.ndjson`,
    lines: streamActivityNdjson({
      projectIds,
      ...readActivityFilters(ctx),
    }),
  });
});

export { activityRouter };
