import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createDataset,
  createDatasetItem,
  createDatasetItemFromGeneration,
  deleteDataset,
  deleteDatasetItem,
  getDataset,
  listDatasetItems,
  listDatasets,
  updateDataset,
  updateDatasetItem,
} from 'src/lib/evaluationDatasets';
import {
  getEvalRun,
  listEvalResults,
  listEvalRuns,
} from 'src/lib/evaluationRunReads';
import { cancelEvalRun, startEvalRun } from 'src/lib/evaluationRuns';
import {
  createEval,
  deleteEval,
  getEval,
  listEvals,
  updateEval,
} from 'src/lib/evaluations';
import { buildSrn } from 'src/lib/iam';
import { parseMetadataBag } from 'src/lib/metadataBag';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  parsePagination,
  requireProjectAccess,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

const evaluationsRouter = new Router<Context>();

const parseStringOrUndefined = (value: unknown): string | undefined => {
  return typeof value === 'string' ? value : undefined;
};

// ── Datasets ───────────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/v1/datasets:
 *   post:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1datasets/post'
 */
evaluationsRouter.post('/datasets', async (ctx: Context) => {
  const body = ctx.request.body as Record<string, unknown>;

  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: parseStringOrUndefined(body.project_id),
    action: 'evaluations:CreateDataset',
    resourceType: 'dataset',
  });

  ctx.status = 201;
  ctx.body = await createDataset({
    projectId: Number(projectId),
    name: body.name,
    description: body.description,
  });
});

/**
 * @openapi
 * /api/v1/datasets:
 *   get:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1datasets/get'
 */
evaluationsRouter.get('/datasets', async (ctx: Context) => {
  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: ctx.query.project_id as string | undefined,
    action: 'evaluations:ListDatasets',
    resourceType: 'dataset',
  });

  ctx.body = await listDatasets({ projectIds, ...parsePagination(ctx) });
});

/**
 * @openapi
 * /api/v1/datasets/{dataset_id}:
 *   get:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1datasets~1{dataset_id}/get'
 */
evaluationsRouter.get('/datasets/:dataset_id', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'evaluations:GetDataset',
    resourceType: 'dataset',
  });
  ctx.body = await getDataset({ projectIds, id: ctx.params.dataset_id });
});

/**
 * @openapi
 * /api/v1/datasets/{dataset_id}:
 *   put:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1datasets~1{dataset_id}/put'
 */
evaluationsRouter.put('/datasets/:dataset_id', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'evaluations:CreateDataset',
    resourceType: 'dataset',
  });
  const body = ctx.request.body as Record<string, unknown>;

  ctx.body = await updateDataset({
    projectIds,
    id: ctx.params.dataset_id,
    name: body.name,
    description: body.description,
  });
});

/**
 * @openapi
 * /api/v1/datasets/{dataset_id}:
 *   delete:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1datasets~1{dataset_id}/delete'
 */
evaluationsRouter.delete('/datasets/:dataset_id', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'evaluations:DeleteDataset',
    resourceType: 'dataset',
  });

  // `204 No Content` leaves the audit middleware no body to derive the
  // project/SRN from, so the resolved resource is handed over before the
  // delete runs (see `setAuditResourceHint`).
  const dataset = await getDataset({ projectIds, id: ctx.params.dataset_id });
  setAuditResourceHint(ctx, {
    projectPublicId: dataset.project_id,
    resourceSrn: buildSrn({
      projectPublicId: dataset.project_id,
      resourceType: 'dataset',
      resourceId: dataset.id,
    }),
    resourcePublicId: dataset.id,
  });

  await deleteDataset({ projectIds, id: ctx.params.dataset_id });
  ctx.status = 204;
});

// ── Dataset items ──────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/v1/datasets/{dataset_id}/items:
 *   post:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1datasets~1{dataset_id}~1items/post'
 */
evaluationsRouter.post('/datasets/:dataset_id/items', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'evaluations:CreateDataset',
    resourceType: 'dataset',
  });
  const body = ctx.request.body as Record<string, unknown>;

  ctx.status = 201;
  ctx.body = await createDatasetItem({
    projectIds,
    datasetId: ctx.params.dataset_id,
    input: body.input,
    expectedOutput: body.expected_output,
    metadata: body.metadata,
  });
});

/**
 * @openapi
 * /api/v1/datasets/{dataset_id}/items/from-generation:
 *   post:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1datasets~1{dataset_id}~1items~1from-generation/post'
 */
evaluationsRouter.post(
  '/datasets/:dataset_id/items/from-generation',
  async (ctx: Context) => {
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'evaluations:CreateDataset',
      resourceType: 'dataset',
    });

    // Curating copies a generation's content into a dataset item, so the caller
    // must be allowed to read that generation as well as to write items —
    // otherwise `evaluations:CreateDataset` alone would be a way to read turns a
    // principal cannot fetch through `GET /generations/{id}`. Both checks resolve
    // the same scope; only the action differs.
    await requireProjectAccess({
      ctx,
      action: 'generations:GetGeneration',
      resourceType: 'generation',
    });

    const body = ctx.request.body as Record<string, unknown>;

    ctx.status = 201;
    ctx.body = await createDatasetItemFromGeneration({
      projectIds,
      datasetId: ctx.params.dataset_id,
      generationId: body.generation_id,
      expectedOutput: body.expected_output,
      metadata: body.metadata,
    });
  }
);

/**
 * @openapi
 * /api/v1/datasets/{dataset_id}/items:
 *   get:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1datasets~1{dataset_id}~1items/get'
 */
evaluationsRouter.get('/datasets/:dataset_id/items', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'evaluations:ListDatasets',
    resourceType: 'dataset',
  });

  ctx.body = await listDatasetItems({
    projectIds,
    datasetId: ctx.params.dataset_id,
    ...parsePagination(ctx),
  });
});

/**
 * @openapi
 * /api/v1/datasets/{dataset_id}/items/{item_id}:
 *   put:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1datasets~1{dataset_id}~1items~1{item_id}/put'
 */
evaluationsRouter.put(
  '/datasets/:dataset_id/items/:item_id',
  async (ctx: Context) => {
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'evaluations:CreateDataset',
      resourceType: 'dataset',
    });
    const body = ctx.request.body as Record<string, unknown>;

    ctx.body = await updateDatasetItem({
      projectIds,
      datasetId: ctx.params.dataset_id,
      itemId: ctx.params.item_id,
      input: body.input,
      expectedOutput: body.expected_output,
      metadata: body.metadata,
    });
  }
);

/**
 * @openapi
 * /api/v1/datasets/{dataset_id}/items/{item_id}:
 *   delete:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1datasets~1{dataset_id}~1items~1{item_id}/delete'
 */
evaluationsRouter.delete(
  '/datasets/:dataset_id/items/:item_id',
  async (ctx: Context) => {
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'evaluations:CreateDataset',
      resourceType: 'dataset',
    });

    await deleteDatasetItem({
      projectIds,
      datasetId: ctx.params.dataset_id,
      itemId: ctx.params.item_id,
    });
    ctx.status = 204;
  }
);

// ── Evals ──────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/v1/evals:
 *   post:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals/post'
 */
evaluationsRouter.post('/evals', async (ctx: Context) => {
  const body = ctx.request.body as Record<string, unknown>;

  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: parseStringOrUndefined(body.project_id),
    action: 'evaluations:CreateEval',
    resourceType: 'eval',
  });

  ctx.status = 201;
  ctx.body = await createEval({
    projectId: Number(projectId),
    name: body.name,
    agentId: body.agent_id,
    datasetId: body.dataset_id,
    scorers: body.scorers,
    passThreshold: body.pass_threshold,
  });
});

/**
 * @openapi
 * /api/v1/evals:
 *   get:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals/get'
 */
evaluationsRouter.get('/evals', async (ctx: Context) => {
  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: ctx.query.project_id as string | undefined,
    action: 'evaluations:ListEvals',
    resourceType: 'eval',
  });

  ctx.body = await listEvals({ projectIds, ...parsePagination(ctx) });
});

/**
 * @openapi
 * /api/v1/evals/{eval_id}:
 *   get:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}/get'
 */
evaluationsRouter.get('/evals/:eval_id', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'evaluations:GetEval',
    resourceType: 'eval',
  });
  ctx.body = await getEval({ projectIds, id: ctx.params.eval_id });
});

/**
 * @openapi
 * /api/v1/evals/{eval_id}:
 *   put:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}/put'
 */
evaluationsRouter.put('/evals/:eval_id', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'evaluations:CreateEval',
    resourceType: 'eval',
  });
  const body = ctx.request.body as Record<string, unknown>;

  ctx.body = await updateEval({
    projectIds,
    id: ctx.params.eval_id,
    name: body.name,
    agentId: body.agent_id,
    datasetId: body.dataset_id,
    scorers: body.scorers,
    passThreshold: body.pass_threshold,
  });
});

/**
 * @openapi
 * /api/v1/evals/{eval_id}:
 *   delete:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}/delete'
 */
evaluationsRouter.delete('/evals/:eval_id', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'evaluations:DeleteEval',
    resourceType: 'eval',
  });

  const evaluation = await getEval({ projectIds, id: ctx.params.eval_id });
  setAuditResourceHint(ctx, {
    projectPublicId: evaluation.project_id,
    resourceSrn: buildSrn({
      projectPublicId: evaluation.project_id,
      resourceType: 'eval',
      resourceId: evaluation.id,
    }),
    resourcePublicId: evaluation.id,
  });

  await deleteEval({ projectIds, id: ctx.params.eval_id });
  ctx.status = 204;
});

// ── Eval runs ──────────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/v1/evals/{eval_id}/runs:
 *   post:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}~1runs/post'
 */
evaluationsRouter.post('/evals/:eval_id/runs', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'evaluations:RunEval',
    resourceType: 'eval',
  });
  const body = ctx.request.body as Record<string, unknown>;

  ctx.status = 201;
  ctx.body = await startEvalRun({
    projectIds,
    evalId: ctx.params.eval_id,
    wait: body.wait,
    agentVersion: body.agent_version,
    baselineRunId: body.baseline_run_id,
    // Rejected here, before the run row exists: a queued run answers 201 long
    // before it scores anything.
    metadata: parseMetadataBag(body.metadata),
  });
});

/**
 * @openapi
 * /api/v1/evals/{eval_id}/runs:
 *   get:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}~1runs/get'
 */
evaluationsRouter.get('/evals/:eval_id/runs', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'evaluations:ListEvals',
    resourceType: 'eval',
  });

  ctx.body = await listEvalRuns({
    projectIds,
    evalId: ctx.params.eval_id,
    ...parsePagination(ctx),
  });
});

/**
 * @openapi
 * /api/v1/evals/{eval_id}/runs/{eval_run_id}:
 *   get:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}~1runs~1{eval_run_id}/get'
 */
evaluationsRouter.get(
  '/evals/:eval_id/runs/:eval_run_id',
  async (ctx: Context) => {
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'evaluations:GetEval',
      resourceType: 'eval',
    });

    ctx.body = await getEvalRun({
      projectIds,
      evalId: ctx.params.eval_id,
      runId: ctx.params.eval_run_id,
    });
  }
);

/**
 * @openapi
 * /api/v1/evals/{eval_id}/runs/{eval_run_id}/results:
 *   get:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}~1runs~1{eval_run_id}~1results/get'
 */
evaluationsRouter.get(
  '/evals/:eval_id/runs/:eval_run_id/results',
  async (ctx: Context) => {
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'evaluations:ListEvals',
      resourceType: 'eval',
    });

    ctx.body = await listEvalResults({
      projectIds,
      evalId: ctx.params.eval_id,
      runId: ctx.params.eval_run_id,
      ...parsePagination(ctx),
    });
  }
);

/**
 * @openapi
 * /api/v1/evals/{eval_id}/runs/{eval_run_id}/cancel:
 *   post:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}~1runs~1{eval_run_id}~1cancel/post'
 */
evaluationsRouter.post(
  '/evals/:eval_id/runs/:eval_run_id/cancel',
  async (ctx: Context) => {
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'evaluations:RunEval',
      resourceType: 'eval',
    });

    ctx.body = await cancelEvalRun({
      projectIds,
      evalId: ctx.params.eval_id,
      runId: ctx.params.eval_run_id,
    });
  }
);

export { evaluationsRouter };
