import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { readRetrievalMode } from 'src/lib/conversationRetrieval';
import { listProjectPrices, upsertProjectPrices } from 'src/lib/priceBook';
import { principalFromAuthUser } from 'src/lib/principals';
import { pauseProject, resumeProject } from 'src/lib/projectPauseActions';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from 'src/lib/projects';

import {
  assertGuardrailDetachAllowed,
  parseGuardrailIds,
} from './guardrailAttach';
import { requireAdmin, requireAuth } from './helpers';

const projectsRouter = new Router<Context>();

type ProjectPriceBody = {
  meter_type?: string;
  provider?: string;
  model?: string;
  component?: string;
  unit?: string;
  unit_price?: number;
  effective_from?: string;
};

// An IAM-authorized action on one project, returning its public id. Existence
// is the lib's to resolve — it 404s an unknown project the caller can reach.
const authorizeProjectAction = async (args: {
  ctx: Context;
  action: string;
}): Promise<string> => {
  const { ctx, action } = args;
  requireAuth(ctx);

  const projectPublicId = ctx.params.project_id;
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId,
    action,
    // Probe with the project's SRN so project-scoped policies grant access,
    // consistent with getProject / resolveProjectIds.
    resource: `srn:${projectPublicId}:*:*`,
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  return projectPublicId;
};

projectsRouter.post('/projects', async (ctx: Context) => {
  requireAdmin(ctx, 'projects:CreateProject');
  const { name } = ctx.request.body as { name?: string };

  if (!name || typeof name !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'name is required');
  }

  const project = await createProject({ name });

  ctx.status = 201;
  ctx.body = project;
});

projectsRouter.get('/projects', async (ctx: Context) => {
  requireAuth(ctx);

  const projects = await listProjects({ authUser: ctx.authUser });
  ctx.body = projects;
});

projectsRouter.get('/projects/:project_id', async (ctx: Context) => {
  requireAuth(ctx);

  const result = await getProject({
    id: ctx.params.project_id,
    authUser: ctx.authUser,
  });

  ctx.body = result;
});

/**
 * A field the body may omit: present means write it, absent means leave the
 * column as it is. Values are forwarded unvalidated so a malformed one is a
 * `400` from the lib rather than a field silently dropped here.
 */
const provided = <T>(
  body: Record<string, unknown>,
  key: string
): T | undefined => {
  return Object.prototype.hasOwnProperty.call(body, key)
    ? (body[key] as T)
    : undefined;
};

/** Parses the optional fields of a project PATCH body, in the camelCase the lib
 * takes. Extracted so the handler stays under the cyclomatic-complexity limit. */
const parseProjectPatchFields = (body: Record<string, unknown>) => {
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    guardrailIds: parseGuardrailIds(body.guardrail_ids),
    // An explicit `null` clears the limit.
    maxConcurrentRuns: provided<number | null>(body, 'max_concurrent_runs'),
    // An explicit `null` clears the project's chain ceiling, leaving the
    // deployment-wide one.
    maxChainGenerations: provided<number | null>(body, 'max_chain_generations'),
    // An explicit `null` clears the project's run-depth bound, leaving the
    // deployment-wide one.
    maxOrchestrationRunDepth: provided<number | null>(
      body,
      'max_orchestration_run_depth'
    ),
    // An explicit `null` clears the project default route.
    defaultModelRouteId: provided<string | null>(
      body,
      'default_model_route_id'
    ),
    auditReadsEnabled:
      typeof body.audit_reads_enabled === 'boolean'
        ? body.audit_reads_enabled
        : undefined,
    requirePricedModel: provided<boolean>(body, 'require_priced_model'),
    defaultConversationRetrieval:
      body.default_conversation_retrieval === undefined
        ? undefined
        : readRetrievalMode(body.default_conversation_retrieval),
    // An explicit `null` disables retention.
    traceContentRetentionDays: provided<number | null>(
      body,
      'trace_content_retention_days'
    ),
    traceContentMode: provided<string>(body, 'trace_content_mode'),
  };
};

projectsRouter.patch('/projects/:project_id', async (ctx: Context) => {
  requireAdmin(ctx, 'projects:UpdateProject');
  const fields = parseProjectPatchFields(
    ctx.request.body as Record<string, unknown>
  );
  const {
    name,
    guardrailIds,
    maxConcurrentRuns,
    maxChainGenerations,
    maxOrchestrationRunDepth,
    defaultModelRouteId,
    auditReadsEnabled,
    requirePricedModel,
    defaultConversationRetrieval,
    traceContentRetentionDays,
    traceContentMode,
  } = fields;

  if (
    Object.values(fields).every((value) => {
      return value === undefined;
    })
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'name, guardrail_ids, max_concurrent_runs, max_chain_generations, max_orchestration_run_depth, default_model_route_id, audit_reads_enabled, require_priced_model, default_conversation_retrieval, trace_content_retention_days, or trace_content_mode is required'
    );
  }

  if (guardrailIds !== undefined) {
    const current = await getProject({
      id: ctx.params.project_id,
      authUser: ctx.authUser!,
    });
    await assertGuardrailDetachAllowed({
      ctx,
      projectPublicId: current.id,
      current: current.guardrail_ids,
      next: guardrailIds,
    });
  }

  const project = await updateProject({
    id: ctx.params.project_id,
    name,
    guardrailIds,
    maxConcurrentRuns,
    maxChainGenerations,
    maxOrchestrationRunDepth,
    defaultModelRouteId,
    auditReadsEnabled,
    requirePricedModel,
    defaultConversationRetrieval,
    traceContentRetentionDays,
    traceContentMode,
  });

  ctx.body = project;
});

projectsRouter.delete('/projects/:project_id', async (ctx: Context) => {
  requireAdmin(ctx, 'projects:DeleteProject');
  const force = ctx.query.force === 'true';

  await deleteProject({ id: ctx.params.project_id, force });

  ctx.status = 204;
});

/**
 * @openapi
 * /api/v1/projects/{project_id}/pause:
 *   post:
 *     $ref: 'openapi/v1/projects.yaml#/paths/~1api~1v1~1projects~1{project_id}~1pause/post'
 */
projectsRouter.post('/projects/:project_id/pause', async (ctx: Context) => {
  const projectPublicId = await authorizeProjectAction({
    ctx,
    action: 'projects:PauseProject',
  });
  const body = ctx.request.body as { reason?: unknown };

  ctx.body = await pauseProject({ id: projectPublicId, reason: body.reason });
});

/**
 * @openapi
 * /api/v1/projects/{project_id}/resume:
 *   post:
 *     $ref: 'openapi/v1/projects.yaml#/paths/~1api~1v1~1projects~1{project_id}~1resume/post'
 */
projectsRouter.post('/projects/:project_id/resume', async (ctx: Context) => {
  requireAuth(ctx);
  const projectPublicId = await authorizeProjectAction({
    ctx,
    action: 'projects:ResumeProject',
  });

  ctx.body = await resumeProject({
    id: projectPublicId,
    // A task's suppressed dispatch runs as whoever resumed: the resume is the
    // decision to spend again.
    principal: principalFromAuthUser(ctx.authUser),
  });
});

projectsRouter.get('/projects/:project_id/prices', async (ctx: Context) => {
  const projectPublicId = await authorizeProjectAction({
    ctx,
    action: 'projects:GetProjectPrices',
  });

  ctx.body = await listProjectPrices({ projectId: projectPublicId });
});

projectsRouter.put('/projects/:project_id/prices', async (ctx: Context) => {
  const projectPublicId = await authorizeProjectAction({
    ctx,
    action: 'projects:ManageProjectPrices',
  });

  const body = ctx.request.body as { prices?: ProjectPriceBody[] };
  const prices = (body.prices ?? []).map((price) => {
    return {
      meterType: price.meter_type,
      provider: price.provider!,
      model: price.model!,
      component: price.component!,
      unit: price.unit!,
      unitPrice: price.unit_price!,
      effectiveFrom: price.effective_from!,
    };
  });

  ctx.body = await upsertProjectPrices({ projectId: projectPublicId, prices });
});

export { projectsRouter };
