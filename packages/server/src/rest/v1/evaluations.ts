import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createDataset,
  createDatasetItem,
  createDatasetItemFromGeneration,
  datasets,
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
  evals,
  getEval,
  listEvals,
  updateEval,
} from 'src/lib/evaluations';
import { generations } from 'src/lib/generations';
import { buildSrn } from 'src/lib/iam';
import { parseMetadataBag } from 'src/lib/metadataBag';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  parsePagination,
  parseToolContextBody,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { authorizeResource, makeItemRouteAuthorizer } from './resourceAccess';

const evaluationsRouter = new Router<Context>();

/**
 * A dataset **item** and an eval **run** carry no project of their own, so they
 * authorize through the parent the path names — the way a memory authorizes
 * through its store. That parent is also the resource a policy author names:
 * `srn:<project>:dataset:<dataset_id>` covers every item in it (#1339).
 *
 * Which refusal each route answers is decided by what its action *does*, not by
 * which helper it happened to reach for: a read hides the resource (`404`), a
 * write refuses it (`403`). This module reached for `requireProjectAccess`
 * everywhere, including on its reads — and preserving that literally would have
 * turned a cross-project read from `404` into `403`, announcing across a tenant
 * boundary that a dataset exists.
 */
const datasetAccess = makeItemRouteAuthorizer({
  findScope: datasets.findScope,
  resourceType: 'dataset',
  param: 'dataset_id',
  label: 'Dataset',
});

const evalAccess = makeItemRouteAuthorizer({
  findScope: evals.findScope,
  resourceType: 'eval',
  param: 'eval_id',
  label: 'Eval',
});

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
  const { projectIds } = await datasetAccess.authorizeRead({
    ctx,
    action: 'evaluations:GetDataset',
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
  const { projectIds } = await datasetAccess.authorizeWrite({
    ctx,
    action: 'evaluations:CreateDataset',
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
  const { projectIds } = await datasetAccess.authorizeWrite({
    ctx,
    action: 'evaluations:DeleteDataset',
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
  const { projectIds } = await datasetAccess.authorizeWrite({
    ctx,
    action: 'evaluations:CreateDataset',
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
    const { projectIds } = await datasetAccess.authorizeWrite({
      ctx,
      action: 'evaluations:CreateDataset',
    });

    const body = ctx.request.body as Record<string, unknown>;

    // Curating copies a generation's content into an item, so without the read
    // check `evaluations:CreateDataset` alone would be a way to read turns a
    // principal cannot fetch through `GET /generations/{id}`. It names the
    // generation's own SRN, as that route does.
    //
    // A body carrying no usable id authorizes nothing because it reads nothing:
    // `createDatasetItemFromGeneration` rejects it before a generation is
    // loaded.
    const generationId = body.generation_id;
    const generationAccess =
      typeof generationId === 'string' && generationId.trim() !== ''
        ? await authorizeResource({
            ctx,
            scope: await generations.findScope({ id: generationId }),
            resourceType: 'generation',
            resourceId: generationId,
            label: 'Generation',
            // The generation is a *referenced* entity here, not the route's
            // subject, so it keeps the module's referenced-entity code rather
            // than the plain `RESOURCE_NOT_FOUND` its own routes answer.
            errorCode: 'GENERATION_NOT_FOUND',
            action: 'generations:GetGeneration',
            onDenied: 'refuse',
          })
        : undefined;

    ctx.status = 201;
    ctx.body = await createDatasetItemFromGeneration({
      // Both projects, because the two lookups behind this call are scoped by
      // one filter: the dataset's and the generation's, each already authorized
      // above. Narrowing to the dataset's alone would make a generation in
      // another project read as missing, where the lib has a `400` naming the
      // mismatch — the far more useful answer for a caller who can see both.
      projectIds: [
        ...new Set([...projectIds, ...(generationAccess?.projectIds ?? [])]),
      ],
      datasetId: ctx.params.dataset_id,
      generationId,
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
  const { projectIds } = await datasetAccess.authorizeRead({
    ctx,
    action: 'evaluations:ListDatasets',
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
    const { projectIds } = await datasetAccess.authorizeWrite({
      ctx,
      action: 'evaluations:CreateDataset',
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
    const { projectIds } = await datasetAccess.authorizeWrite({
      ctx,
      action: 'evaluations:CreateDataset',
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
  const { projectIds } = await evalAccess.authorizeRead({
    ctx,
    action: 'evaluations:GetEval',
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
  const { projectIds } = await evalAccess.authorizeWrite({
    ctx,
    action: 'evaluations:CreateEval',
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
  const { projectIds } = await evalAccess.authorizeWrite({
    ctx,
    action: 'evaluations:DeleteEval',
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
  const { projectIds } = await evalAccess.authorizeWrite({
    ctx,
    action: 'evaluations:RunEval',
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
    toolContext: parseToolContextBody(body.tool_context),
  });
});

/**
 * @openapi
 * /api/v1/evals/{eval_id}/runs:
 *   get:
 *     $ref: 'openapi/v1/evaluations.yaml#/paths/~1api~1v1~1evals~1{eval_id}~1runs/get'
 */
evaluationsRouter.get('/evals/:eval_id/runs', async (ctx: Context) => {
  const { projectIds } = await evalAccess.authorizeRead({
    ctx,
    action: 'evaluations:ListEvals',
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
    const { projectIds } = await evalAccess.authorizeRead({
      ctx,
      action: 'evaluations:GetEval',
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
    const { projectIds } = await evalAccess.authorizeRead({
      ctx,
      action: 'evaluations:ListEvals',
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
    const { projectIds } = await evalAccess.authorizeWrite({
      ctx,
      action: 'evaluations:RunEval',
    });

    ctx.body = await cancelEvalRun({
      projectIds,
      evalId: ctx.params.eval_id,
      runId: ctx.params.eval_run_id,
    });
  }
);

export { evaluationsRouter };
