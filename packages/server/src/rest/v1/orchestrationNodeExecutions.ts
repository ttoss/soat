import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { listOrchestrationRunNodeExecutions } from 'src/lib/orchestrationNodeExecutions';

import { parsePagination } from './helpers';
import { authorizeRunRead } from './orchestrationAccess';

/**
 * A run's node executions, paged. Reading them is reading the run
 * (`orchestrations:GetRun`); the run itself carries none of them.
 */
export const orchestrationNodeExecutionsRouter = new Router<Context>();

/**
 * @openapi
 * /api/v1/orchestration-runs/{orchestration_run_id}/node-executions:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs~1{orchestration_run_id}~1node-executions/get'
 */
orchestrationNodeExecutionsRouter.get(
  '/orchestration-runs/:orchestration_run_id/node-executions',
  async (ctx: Context) => {
    const { projectIds } = await authorizeRunRead({
      ctx,
      action: 'orchestrations:GetRun',
    });

    ctx.body = await listOrchestrationRunNodeExecutions({
      runId: ctx.params.orchestration_run_id,
      projectIds: projectIds ?? undefined,
      ...parsePagination(ctx),
    });
  }
);
