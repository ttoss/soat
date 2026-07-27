import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { parseOrchestrationGraph } from 'src/lib/orchestrationGraphWire';
import {
  cancelOrchestrationRun,
  createOrchestration,
  deleteOrchestration,
  findOrchestration,
  findOrchestrationRun,
  listOrchestrationRuns,
  listOrchestrations,
  resumeOrchestrationRun,
  startOrchestrationRun,
  submitHumanInput,
  updateOrchestration,
  validateOrchestrationGraph,
} from 'src/lib/orchestrations';

import { parsePagination } from './helpers';
import {
  hintAuditResourceForOrchestration,
  resolveRunAuth,
  resolveStartRunScope,
} from './orchestrationAuth';
import {
  parseRunInput,
  parseUpdateBody,
  type RawCreateBody,
  type RawUpdateBody,
  validateCreateBody,
} from './orchestrationsRequestBody';

export const orchestrationsRouter = new Router<Context>();
const resolveAuth = async (
  ctx: Context,
  action: string,
  projectPublicId?: string
): Promise<{ projectIds: number[]; primaryId: number } | null> => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }
  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action,
    resourceType: 'orchestration',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  const primaryId = projectIds?.[0] ?? ctx.authUser.apiKeyProjectId;
  if (!primaryId) {
    ctx.status = 400;
    ctx.body = { error: 'project_id is required' };
    return null;
  }
  return { projectIds: projectIds ?? [primaryId], primaryId };
};
const resolveOrchestrationAccess = async (
  ctx: Context,
  action: string
): Promise<number[] | undefined | null> => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }
  const projectIds = await ctx.authUser.resolveProjectIds({
    action,
    resourceType: 'orchestration',
  });
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  return projectIds ?? undefined;
};
/**
 * @openapi
 * /api/v1/orchestrations:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations/post'
 */
orchestrationsRouter.post('/orchestrations', async (ctx: Context) => {
  const body = (ctx.request.body ?? {}) as RawCreateBody;

  const validated = validateCreateBody(body);
  if ('error' in validated) {
    ctx.status = 400;
    ctx.body = { error: validated.error };
    return;
  }

  const auth = await resolveAuth(
    ctx,
    'orchestrations:CreateOrchestration',
    body.project_id
  );
  if (!auth) return;

  const graph = parseOrchestrationGraph({
    nodes: validated.nodes,
    edges: validated.edges,
  });

  const result = await createOrchestration({
    projectId: auth.primaryId,
    name: validated.name,
    description:
      typeof body.description === 'string' ? body.description : undefined,
    nodes: graph.nodes as never[],
    edges: graph.edges as never[],
    stateSchema:
      body.state_schema != null && typeof body.state_schema === 'object'
        ? body.state_schema
        : undefined,
    inputSchema:
      body.input_schema != null && typeof body.input_schema === 'object'
        ? body.input_schema
        : undefined,
  });

  ctx.status = 201;
  ctx.body = result;
});
/**
 * @openapi
 * /api/v1/orchestrations/validate:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1validate/post'
 */
orchestrationsRouter.post('/orchestrations/validate', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }
  const body = (ctx.request.body ?? {}) as {
    nodes?: unknown;
    edges?: unknown;
    input_schema?: unknown;
  };
  ctx.body = validateOrchestrationGraph({
    ...parseOrchestrationGraph({ nodes: body.nodes, edges: body.edges }),
    inputSchema: (body.input_schema as object | null) ?? null,
  });
  ctx.status = 200;
});
/**
 * @openapi
 * /api/v1/orchestrations:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations/get'
 */
orchestrationsRouter.get('/orchestrations', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'orchestrations:ListOrchestrations',
    resourceType: 'orchestration',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  if (!projectIds || projectIds.length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'project_id is required' };
    return;
  }

  ctx.body = await listOrchestrations({ projectIds, ...parsePagination(ctx) });
});
/**
 * @openapi
 * /api/v1/orchestrations/{orchestration_id}:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1{orchestration_id}/get'
 */
orchestrationsRouter.get(
  '/orchestrations/:orchestration_id',
  async (ctx: Context) => {
    const projectIds = await resolveOrchestrationAccess(
      ctx,
      'orchestrations:GetOrchestration'
    );
    if (projectIds === null) return;

    const orchestrationId = ctx.params['orchestration_id'] as string;

    const result = await findOrchestration({
      id: orchestrationId,
      projectIds: projectIds ?? undefined,
    });

    if (!result) {
      ctx.status = 404;
      ctx.body = { error: 'Orchestration not found' };
      return;
    }

    ctx.body = result;
  }
);
/**
 * @openapi
 * /api/v1/orchestrations/{orchestration_id}:
 *   patch:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1{orchestration_id}/patch'
 */
orchestrationsRouter.patch(
  '/orchestrations/:orchestration_id',
  async (ctx: Context) => {
    const projectIds = await resolveOrchestrationAccess(
      ctx,
      'orchestrations:UpdateOrchestration'
    );
    if (projectIds === null) return;

    const orchestrationId = ctx.params['orchestration_id'] as string;
    const body = (ctx.request.body ?? {}) as RawUpdateBody;

    const result = await updateOrchestration({
      id: orchestrationId,
      projectIds: projectIds ?? undefined,
      ...parseUpdateBody(body),
    });

    ctx.body = result;
  }
);
/**
 * @openapi
 * /api/v1/orchestrations/{orchestration_id}:
 *   delete:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1{orchestration_id}/delete'
 */
orchestrationsRouter.delete(
  '/orchestrations/:orchestration_id',
  async (ctx: Context) => {
    const projectIds = await resolveOrchestrationAccess(
      ctx,
      'orchestrations:DeleteOrchestration'
    );
    if (projectIds === null) return;

    const target = {
      id: ctx.params['orchestration_id'] as string,
      projectIds: projectIds ?? undefined,
    };
    await hintAuditResourceForOrchestration({ ctx, ...target });
    await deleteOrchestration(target);

    ctx.status = 204;
  }
);
/**
 * @openapi
 * /api/v1/orchestration-runs:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs/post'
 */
orchestrationsRouter.post('/orchestration-runs', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = (ctx.request.body ?? {}) as {
    orchestration_id?: unknown;
    input?: unknown;
    wait?: unknown;
  };
  const orchestrationId =
    typeof body.orchestration_id === 'string'
      ? body.orchestration_id
      : undefined;
  if (!orchestrationId) {
    ctx.status = 400;
    ctx.body = { error: 'orchestration_id is required' };
    return;
  }

  const scope = await resolveStartRunScope(ctx);
  if (!scope) return;

  const input = parseRunInput(body.input);
  const authHeader = ctx.headers['authorization'] as string | undefined;

  const result = await startOrchestrationRun({
    orchestrationPublicId: orchestrationId,
    projectId: scope.primaryId,
    projectIds: scope.projectIds,
    input,
    authHeader,
    wait: body.wait === true,
  });

  ctx.status = 201;
  ctx.body = result;
});
/**
 * @openapi
 * /api/v1/orchestration-runs:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs/get'
 */
orchestrationsRouter.get('/orchestration-runs', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const orchestrationId = ctx.query['orchestration_id'] as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'orchestrations:ListRuns',
    resourceType: 'orchestration',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await listOrchestrationRuns({
    orchestrationPublicId: orchestrationId,
    projectIds: projectIds ?? undefined,
    ...parsePagination(ctx),
  });

  ctx.body = result;
});
/**
 * @openapi
 * /api/v1/orchestration-runs/{run_id}:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs~1{run_id}/get'
 */
orchestrationsRouter.get(
  '/orchestration-runs/:run_id',
  async (ctx: Context) => {
    const projectIds = await resolveOrchestrationAccess(
      ctx,
      'orchestrations:GetRun'
    );
    if (projectIds === null) return;

    const runId = ctx.params['run_id'] as string;

    const result = await findOrchestrationRun({
      id: runId,
      projectIds: projectIds ?? undefined,
    });

    if (!result) {
      ctx.status = 404;
      ctx.body = { error: 'Orchestration run not found' };
      return;
    }

    ctx.body = result;
  }
);
/**
 * @openapi
 * /api/v1/orchestration-runs/{run_id}/cancel:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs~1{run_id}~1cancel/post'
 */
orchestrationsRouter.post(
  '/orchestration-runs/:run_id/cancel',
  async (ctx: Context) => {
    const runId = ctx.params['run_id'] as string;
    const auth = await resolveRunAuth(ctx, 'orchestrations:CancelRun');
    if (!auth) return;

    const result = await cancelOrchestrationRun({
      runPublicId: runId,
      projectIds: auth.projectIds,
    });

    ctx.body = result;
  }
);
/**
 * @openapi
 * /api/v1/orchestration-runs/{run_id}/human-input:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs~1{run_id}~1human-input/post'
 */
orchestrationsRouter.post(
  '/orchestration-runs/:run_id/human-input',
  async (ctx: Context) => {
    const runId = ctx.params['run_id'] as string;
    const auth = await resolveRunAuth(ctx, 'orchestrations:SubmitHumanInput');
    if (!auth) return;

    const body = (ctx.request.body ?? {}) as {
      node_id?: unknown;
      output?: unknown;
    };

    const nodeId = typeof body.node_id === 'string' ? body.node_id : undefined;
    const output =
      typeof body.output === 'object' && body.output !== null
        ? (body.output as Record<string, unknown>)
        : {};

    if (!nodeId) {
      ctx.status = 400;
      ctx.body = { error: 'nodeId is required' };
      return;
    }

    const result = await submitHumanInput({
      runPublicId: runId,
      projectIds: auth.projectIds,
      nodeId,
      output,
    });

    ctx.body = result;
  }
);
/**
 * @openapi
 * /api/v1/orchestration-runs/{run_id}/resume:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs~1{run_id}~1resume/post'
 */
orchestrationsRouter.post(
  '/orchestration-runs/:run_id/resume',
  async (ctx: Context) => {
    const runId = ctx.params['run_id'] as string;
    const auth = await resolveRunAuth(ctx, 'orchestrations:ResumeRun');
    if (!auth) return;

    const result = await resumeOrchestrationRun({
      runPublicId: runId,
      projectIds: auth.projectIds,
    });

    ctx.body = result;
  }
);
