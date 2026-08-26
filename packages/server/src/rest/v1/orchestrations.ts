import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { parseMetadataBag } from 'src/lib/metadataBag';
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

import {
  parsePagination,
  requestPrincipalFromCtx,
  requireAuth,
  requireProjectAccess,
  resolveReadProjectIds,
} from './helpers';
import {
  hintAuditResourceForOrchestration,
  resolveRunAuth,
  resolveStartRunScope,
} from './orchestrationAuth';
import {
  parseRunInput,
  parseRunToolContext,
  parseUpdateBody,
  parseVersionLabel,
  type RawCreateBody,
  type RawUpdateBody,
  validateCreateBody,
} from './orchestrationsRequestBody';
import { orchestrationVersionsRouter } from './orchestrationVersions';

export const orchestrationsRouter = new Router<Context>();

const resolveAuth = async (
  ctx: Context,
  action: string,
  projectPublicId?: string
): Promise<{ projectIds: number[]; primaryId: number }> => {
  requireAuth(ctx);
  // `requireProjectAccess`, not the read helper: a caller permitted in zero
  // projects cannot create here, and an empty scope must say so with a `403`
  // rather than falling through to "project_id is required" (#1029).
  const projectIds = await requireProjectAccess({
    ctx,
    projectPublicId,
    action,
    resourceType: 'orchestration',
  });

  const primaryId = projectIds?.[0] ?? ctx.authUser.apiKeyProjectId;
  if (!primaryId) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required');
  }
  return { projectIds: projectIds ?? [primaryId], primaryId };
};
/**
 * @openapi
 * /api/v1/orchestrations:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations/post'
 */
orchestrationsRouter.post('/orchestrations', async (ctx: Context) => {
  const body = ctx.request.body as RawCreateBody;

  const validated = validateCreateBody(body);
  if ('error' in validated) {
    throw new DomainError('VALIDATION_FAILED', validated.error);
  }

  const auth = await resolveAuth(
    ctx,
    'orchestrations:CreateOrchestration',
    body.project_id
  );

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
    versionLabel: parseVersionLabel(body.version_label),
    createdByUserId: ctx.authUser?.id,
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
  requireAuth(ctx);
  const body = ctx.request.body as {
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
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'orchestrations:ListOrchestrations',
    resourceType: 'orchestration',
  });

  if (!projectIds || projectIds.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required');
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
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'orchestrations:GetOrchestration',
      resourceType: 'orchestration',
    });
    const orchestrationId = ctx.params['orchestration_id'] as string;

    const result = await findOrchestration({
      id: orchestrationId,
      projectIds: projectIds ?? undefined,
    });

    if (!result) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Orchestration not found');
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
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'orchestrations:UpdateOrchestration',
      resourceType: 'orchestration',
    });
    const orchestrationId = ctx.params['orchestration_id'] as string;
    const body = ctx.request.body as RawUpdateBody;

    const result = await updateOrchestration({
      id: orchestrationId,
      projectIds: projectIds ?? undefined,
      ...parseUpdateBody(body),
      createdByUserId: ctx.authUser?.id,
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
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'orchestrations:DeleteOrchestration',
      resourceType: 'orchestration',
    });
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
  requireAuth(ctx);

  const body = ctx.request.body as {
    orchestration_id?: unknown;
    input?: unknown;
    tool_context?: unknown;
    metadata?: unknown;
    wait?: unknown;
  };
  const orchestrationId =
    typeof body.orchestration_id === 'string'
      ? body.orchestration_id
      : undefined;
  if (!orchestrationId) {
    throw new DomainError('VALIDATION_FAILED', 'orchestration_id is required');
  }

  const scope = await resolveStartRunScope(ctx);
  if (!scope) return;

  const input = parseRunInput(body.input);
  const toolContext = parseRunToolContext(body.tool_context);
  // Rejected before the run row is written: an async run answers 201 long
  // before it executes, so a bag the caller cannot be told about later has to
  // fail while the caller is still listening.
  const metadata = parseMetadataBag(body.metadata);
  const authHeader = ctx.headers['authorization'] as string | undefined;

  const result = await startOrchestrationRun({
    orchestrationPublicId: orchestrationId,
    projectId: scope.primaryId,
    projectIds: scope.projectIds,
    input,
    // Persisted on the run, not borrowed from this request: the run's later
    // drives (a worker, a wake, a resume) have no request to read it from.
    toolContext,
    // The caller's own label for this run. Stored beside `input`, never merged
    // into run state.
    metadata,
    authHeader,
    // Persisted on the run so a worker driving it later can act as the same
    // principal; the request's own header only reaches `wait` mode.
    principal: requestPrincipalFromCtx(ctx),
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
  requireAuth(ctx);

  const orchestrationId = ctx.query['orchestration_id'] as string | undefined;
  const parentRunId = ctx.query['parent_orchestration_run_id'] as
    string | undefined;

  // Parsed rather than coerced: `nested=maybe` silently becoming `true` would
  // hand back a list the caller did not ask for, and an aggregate over it is
  // wrong by exactly the double-count this filter exists to prevent.
  const nestedRaw = ctx.query['nested'] as string | undefined;
  if (
    nestedRaw !== undefined &&
    nestedRaw !== 'true' &&
    nestedRaw !== 'false'
  ) {
    ctx.status = 400;
    ctx.body = {
      code: 'VALIDATION_FAILED',
      message: "`nested` must be 'true' or 'false'",
    };
    return;
  }
  const nested = nestedRaw === undefined ? undefined : nestedRaw === 'true';

  // A parent id already asserts the run has a parent, so pairing it with
  // `nested=false` asks for two contradictory things at once.
  if (parentRunId !== undefined && nested === false) {
    ctx.status = 400;
    ctx.body = {
      code: 'VALIDATION_FAILED',
      message:
        '`nested=false` contradicts `parent_orchestration_run_id`, which selects runs that have a parent',
    };
    return;
  }

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'orchestrations:ListRuns',
    resourceType: 'orchestration',
  });

  const result = await listOrchestrationRuns({
    orchestrationPublicId: orchestrationId,
    parentRunId,
    nested,
    projectIds: projectIds ?? undefined,
    ...parsePagination(ctx),
  });

  ctx.body = result;
});
/**
 * @openapi
 * /api/v1/orchestration-runs/{orchestration_run_id}:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs~1{orchestration_run_id}/get'
 */
orchestrationsRouter.get(
  '/orchestration-runs/:orchestration_run_id',
  async (ctx: Context) => {
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'orchestrations:GetRun',
      resourceType: 'orchestration',
    });
    const orchestrationRunId = ctx.params['orchestration_run_id'] as string;

    const result = await findOrchestrationRun({
      id: orchestrationRunId,
      projectIds: projectIds ?? undefined,
    });

    if (!result) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        'Orchestration run not found'
      );
    }

    ctx.body = result;
  }
);
/**
 * @openapi
 * /api/v1/orchestration-runs/{orchestration_run_id}/cancel:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs~1{orchestration_run_id}~1cancel/post'
 */
orchestrationsRouter.post(
  '/orchestration-runs/:orchestration_run_id/cancel',
  async (ctx: Context) => {
    const orchestrationRunId = ctx.params['orchestration_run_id'] as string;
    const auth = await resolveRunAuth(ctx, 'orchestrations:CancelRun');

    const result = await cancelOrchestrationRun({
      runPublicId: orchestrationRunId,
      projectIds: auth.projectIds,
    });

    ctx.body = result;
  }
);
/**
 * @openapi
 * /api/v1/orchestration-runs/{orchestration_run_id}/human-input:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs~1{orchestration_run_id}~1human-input/post'
 */
orchestrationsRouter.post(
  '/orchestration-runs/:orchestration_run_id/human-input',
  async (ctx: Context) => {
    const orchestrationRunId = ctx.params['orchestration_run_id'] as string;
    const auth = await resolveRunAuth(ctx, 'orchestrations:SubmitHumanInput');

    const body = ctx.request.body as {
      node_id?: unknown;
      output?: unknown;
    };

    const nodeId = typeof body.node_id === 'string' ? body.node_id : undefined;
    const output =
      typeof body.output === 'object' && body.output !== null
        ? (body.output as Record<string, unknown>)
        : {};

    if (!nodeId) {
      throw new DomainError('VALIDATION_FAILED', 'nodeId is required');
    }

    const result = await submitHumanInput({
      runPublicId: orchestrationRunId,
      projectIds: auth.projectIds,
      nodeId,
      output,
    });

    ctx.body = result;
  }
);
/**
 * @openapi
 * /api/v1/orchestration-runs/{orchestration_run_id}/resume:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestration-runs~1{orchestration_run_id}~1resume/post'
 */
orchestrationsRouter.post(
  '/orchestration-runs/:orchestration_run_id/resume',
  async (ctx: Context) => {
    const orchestrationRunId = ctx.params['orchestration_run_id'] as string;
    const auth = await resolveRunAuth(ctx, 'orchestrations:ResumeRun');

    const result = await resumeOrchestrationRun({
      runPublicId: orchestrationRunId,
      projectIds: auth.projectIds,
    });

    ctx.body = result;
  }
);

// The version-history surface lives in its own file and hangs off this router,
// mirroring `agentVersions.ts` under the agents router.
orchestrationsRouter.use(orchestrationVersionsRouter.routes());
orchestrationsRouter.use(orchestrationVersionsRouter.allowedMethods());
