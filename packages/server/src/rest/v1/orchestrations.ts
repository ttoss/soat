import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import type {
  OrchestrationEdge,
  OrchestrationNode,
} from 'src/lib/orchestrations';
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

import { resolveStartRunScope } from './orchestrationAuth';

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
type RawCreateBody = {
  projectId?: string;
  name?: unknown;
  description?: unknown;
  nodes?: unknown;
  edges?: unknown;
  stateSchema?: unknown;
  inputSchema?: unknown;
};
const validateCreateBody = (
  body: RawCreateBody
): { error: string } | { name: string; nodes: unknown[]; edges: unknown[] } => {
  if (!body.name || typeof body.name !== 'string') {
    return { error: 'name is required' };
  }
  if (!Array.isArray(body.nodes)) {
    return { error: 'nodes must be an array' };
  }
  if (!Array.isArray(body.edges)) {
    return { error: 'edges must be an array' };
  }
  return { name: body.name, nodes: body.nodes, edges: body.edges };
};
type RawUpdateBody = {
  name?: unknown;
  description?: unknown;
  nodes?: unknown;
  edges?: unknown;
  stateSchema?: unknown;
  inputSchema?: unknown;
};

const parseUpdateBody = (body: RawUpdateBody) => {
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    description:
      body.description !== undefined
        ? body.description === null
          ? null
          : String(body.description)
        : undefined,
    nodes: Array.isArray(body.nodes) ? (body.nodes as never[]) : undefined,
    edges: Array.isArray(body.edges) ? (body.edges as never[]) : undefined,
    stateSchema:
      body.stateSchema !== undefined
        ? (body.stateSchema as object | null)
        : undefined,
    inputSchema:
      body.inputSchema !== undefined
        ? (body.inputSchema as object | null)
        : undefined,
  };
};

const parseRunInput = (raw: unknown): Record<string, unknown> | undefined => {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
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
    body.projectId
  );
  if (!auth) return;

  const result = await createOrchestration({
    projectId: auth.primaryId,
    name: validated.name,
    description:
      typeof body.description === 'string' ? body.description : undefined,
    nodes: validated.nodes as never[],
    edges: validated.edges as never[],
    stateSchema:
      body.stateSchema != null && typeof body.stateSchema === 'object'
        ? body.stateSchema
        : undefined,
    inputSchema:
      body.inputSchema != null && typeof body.inputSchema === 'object'
        ? body.inputSchema
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
    inputSchema?: unknown;
  };
  ctx.body = validateOrchestrationGraph({
    nodes: Array.isArray(body.nodes) ? (body.nodes as OrchestrationNode[]) : [],
    edges: Array.isArray(body.edges) ? (body.edges as OrchestrationEdge[]) : [],
    inputSchema: (body.inputSchema as object | null) ?? null,
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

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'orchestrations:ListOrchestrations',
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

  ctx.body = await listOrchestrations({ projectIds });
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
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const orchestrationId = ctx.params['orchestration_id'] as string;
    const projectIds = await ctx.authUser.resolveProjectIds({
      action: 'orchestrations:GetOrchestration',
    });

    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

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
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const orchestrationId = ctx.params['orchestration_id'] as string;
    const projectIds = await ctx.authUser.resolveProjectIds({
      action: 'orchestrations:UpdateOrchestration',
    });

    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

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
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const orchestrationId = ctx.params['orchestration_id'] as string;
    const projectIds = await ctx.authUser.resolveProjectIds({
      action: 'orchestrations:DeleteOrchestration',
    });

    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    await deleteOrchestration({
      id: orchestrationId,
      projectIds: projectIds ?? undefined,
    });

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
    orchestrationId?: unknown;
    input?: unknown;
    wait?: unknown;
  };
  const orchestrationId =
    typeof body.orchestrationId === 'string' ? body.orchestrationId : undefined;
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

  const orchestrationId = ctx.query['orchestrationId'] as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'orchestrations:ListRuns',
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
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const runId = ctx.params['run_id'] as string;

    const projectIds = await ctx.authUser.resolveProjectIds({
      action: 'orchestrations:GetRun',
    });

    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

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
    const auth = await resolveAuth(ctx, 'orchestrations:CancelRun');
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
    const auth = await resolveAuth(ctx, 'orchestrations:SubmitHumanInput');
    if (!auth) return;

    const body = (ctx.request.body ?? {}) as {
      nodeId?: unknown;
      output?: unknown;
    };

    const nodeId = typeof body.nodeId === 'string' ? body.nodeId : undefined;
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
    const auth = await resolveAuth(ctx, 'orchestrations:ResumeRun');
    if (!auth) return;

    const result = await resumeOrchestrationRun({
      runPublicId: runId,
      projectIds: auth.projectIds,
    });

    ctx.body = result;
  }
);
