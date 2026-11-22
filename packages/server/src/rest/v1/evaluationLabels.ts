import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  clearEvalResultLabel,
  labelEvalResult,
} from 'src/lib/evaluationLabels';

import { evalAccess } from './evaluations';
import { requestPrincipalFromCtx } from './helpers';

const evaluationLabelsRouter = new Router();

/**
 * @openapi
 * /api/v1/evals/{eval_id}/runs/{eval_run_id}/results/{eval_result_id}/label:
 *   put:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}~1runs~1{eval_run_id}~1results~1{eval_result_id}~1label/put'
 */
evaluationLabelsRouter.put(
  '/evals/:eval_id/runs/:eval_run_id/results/:eval_result_id/label',
  async (ctx: Context) => {
    const { projectIds } = await evalAccess.authorizeWrite({
      ctx,
      action: 'evaluations:LabelEvalResult',
    });
    const { passed, note } = ctx.request.body as {
      passed?: unknown;
      note?: unknown;
    };
    if (typeof passed !== 'boolean') {
      throw new DomainError('VALIDATION_FAILED', 'passed must be a boolean.');
    }

    ctx.body = await labelEvalResult({
      projectIds,
      evalId: ctx.params.eval_id,
      runId: ctx.params.eval_run_id,
      resultId: ctx.params.eval_result_id,
      passed,
      note: typeof note === 'string' ? note : null,
      labeledBy: requestPrincipalFromCtx(ctx),
    });
  }
);

/**
 * @openapi
 * /api/v1/evals/{eval_id}/runs/{eval_run_id}/results/{eval_result_id}/label:
 *   delete:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}~1runs~1{eval_run_id}~1results~1{eval_result_id}~1label/delete'
 */
evaluationLabelsRouter.delete(
  '/evals/:eval_id/runs/:eval_run_id/results/:eval_result_id/label',
  async (ctx: Context) => {
    const { projectIds } = await evalAccess.authorizeWrite({
      ctx,
      action: 'evaluations:LabelEvalResult',
    });

    await clearEvalResultLabel({
      projectIds,
      evalId: ctx.params.eval_id,
      runId: ctx.params.eval_run_id,
      resultId: ctx.params.eval_result_id,
    });
    ctx.status = 204;
  }
);

export { evaluationLabelsRouter };
