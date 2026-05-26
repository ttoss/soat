import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createOrchestration,
  deleteOrchestration,
  findOrchestration,
  findOrchestrationRun,
  listOrchestrationRuns,
  listOrchestrations,
  startOrchestrationRun,
  updateOrchestration,
} from 'src/lib/orchestrations';

export const orchestrationsRouter = new Router<Context>();

// ── Auth helpers ──────────────────────────────────────────────────────────

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

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/v1/orchestrations:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations/post'
 */
orchestrationsRouter.post('/orchestrations', async (ctx: Context) => {
  const body = (ctx.request.body ?? {}) as {
    projectId?: string;
    name?: unknown;
    description?: unknown;
    nodes?: unknown;
    edges?: unknown;
    stateSchema?: unknown;
    inputSchema?: unknown;
  };

  if (!body.name || typeof body.name !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  if (!Array.isArray(body.nodes)) {
    ctx.status = 400;
    ctx.body = { error: 'nodes must be an array' };
    return;
  }

  if (!Array.isArray(body.edges)) {
    ctx.status = 400;
    ctx.body = { error: 'edges must be an array' };
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
    name: body.name,
    description:
      typeof body.description === 'string' ? body.description : undefined,
    nodes: body.nodes as never[],
    edges: body.edges as never[],
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

    const body = (ctx.request.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      nodes?: unknown;
      edges?: unknown;
      stateSchema?: unknown;
      inputSchema?: unknown;
    };

    const result = await updateOrchestration({
      id: orchestrationId,
      projectIds: projectIds ?? undefined,
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
 * /api/v1/orchestrations/{orchestration_id}/runs:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1{orchestration_id}~1runs/post'
 */
orchestrationsRouter.post(
  '/orchestrations/:orchestration_id/runs',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const orchestrationId = ctx.params['orchestration_id'] as string;

    const projectIds = await ctx.authUser.resolveProjectIds({
      action: 'orchestrations:StartRun',
    });

    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const allProjectIds = projectIds ?? [];
    const primaryId = allProjectIds[0] ?? ctx.authUser.apiKeyProjectId;
    if (!primaryId) {
      ctx.status = 400;
      ctx.body = { error: 'project_id is required' };
      return;
    }

    const body = (ctx.request.body ?? {}) as { input?: unknown };
    const input =
      body.input != null &&
      typeof body.input === 'object' &&
      !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : undefined;

    const authHeader = ctx.headers['authorization'] as string | undefined;

    const result = await startOrchestrationRun({
      orchestrationPublicId: orchestrationId,
      projectId: primaryId,
      projectIds: allProjectIds.length > 0 ? allProjectIds : [primaryId],
      input,
      authHeader,
    });

    ctx.status = 201;
    ctx.body = result;
  }
);

/**
 * @openapi
 * /api/v1/orchestrations/{orchestration_id}/runs:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1{orchestration_id}~1runs/get'
 */
orchestrationsRouter.get(
  '/orchestrations/:orchestration_id/runs',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const orchestrationId = ctx.params['orchestration_id'] as string;

    const projectIds = await ctx.authUser.resolveProjectIds({
      action: 'orchestrations:ListRuns',
    });

    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const result = await listOrchestrationRuns({
      orchestrationPublicId: orchestrationId,
      projectIds: projectIds ?? undefined,
    });

    ctx.body = result;
  }
);

/**
 * @openapi
 * /api/v1/orchestrations/{orchestration_id}/runs/{run_id}:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1{orchestration_id}~1runs~1{run_id}/get'
 */
orchestrationsRouter.get(
  '/orchestrations/:orchestration_id/runs/:run_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const orchestrationId = ctx.params['orchestration_id'] as string;
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
      orchestrationId,
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
