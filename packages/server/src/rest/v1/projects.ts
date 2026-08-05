import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { listProjectPrices, upsertProjectPrices } from 'src/lib/priceBook';
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
import { requireAdmin } from './helpers';

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

// Authorizes a project-scoped price request against the project itself.
// Returns the project public ID, or null when a 401/403 response has already
// been set on ctx and the caller should return. The lib resolves existence and
// throws RESOURCE_NOT_FOUND (404) for an unknown project the caller can reach.
const authorizeProjectPrices = async (args: {
  ctx: Context;
  action: string;
}): Promise<string | null> => {
  const { ctx, action } = args;
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }

  const projectPublicId = ctx.params.project_id;
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId,
    action,
    // Probe with the project's SRN so project-scoped policies grant access,
    // consistent with getProject / resolveProjectIds.
    resource: `soat:${projectPublicId}:*:*`,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }

  return projectPublicId;
};

projectsRouter.post('/projects', async (ctx: Context) => {
  if (!requireAdmin(ctx, 'projects:CreateProject')) return;

  const { name } = ctx.request.body as { name?: string };

  if (!name || typeof name !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  const project = await createProject({ name });

  ctx.status = 201;
  ctx.body = project;
});

projectsRouter.get('/projects', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projects = await listProjects({ authUser: ctx.authUser });
  ctx.body = projects;
});

projectsRouter.get('/projects/:project_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const result = await getProject({
    id: ctx.params.project_id,
    authUser: ctx.authUser,
  });

  ctx.body = result;
});

/** Parses the optional fields of a project PATCH body. Every field distinguishes
 * "absent" (leave as-is) from a value; extracted so the handler stays under the
 * cyclomatic-complexity limit. */
const parseProjectPatchFields = (body: Record<string, unknown>) => {
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    guardrailIds: parseGuardrailIds(body.guardrail_ids),
    // An explicit `null` clears the limit. Any non-null, non-integer value is
    // forwarded so the lib rejects it with a 400 rather than being silently
    // dropped here.
    maxConcurrentRuns: Object.prototype.hasOwnProperty.call(
      body,
      'max_concurrent_runs'
    )
      ? (body.max_concurrent_runs as number | null)
      : undefined,
    // An explicit `null` clears the project default route; absent leaves it.
    defaultModelRouteId: Object.prototype.hasOwnProperty.call(
      body,
      'default_model_route_id'
    )
      ? (body.default_model_route_id as string | null)
      : undefined,
    auditReadsEnabled:
      typeof body.audit_reads_enabled === 'boolean'
        ? body.audit_reads_enabled
        : undefined,
    // An explicit `null` disables retention. Any other non-conforming value is
    // forwarded so the lib rejects it with a 400 rather than being dropped.
    traceContentRetentionDays: Object.prototype.hasOwnProperty.call(
      body,
      'trace_content_retention_days'
    )
      ? (body.trace_content_retention_days as number | null)
      : undefined,
    traceContentMode: Object.prototype.hasOwnProperty.call(
      body,
      'trace_content_mode'
    )
      ? (body.trace_content_mode as string)
      : undefined,
  };
};

projectsRouter.patch('/projects/:project_id', async (ctx: Context) => {
  if (!requireAdmin(ctx, 'projects:UpdateProject')) return;

  const fields = parseProjectPatchFields(
    ctx.request.body as Record<string, unknown>
  );
  const {
    name,
    guardrailIds,
    maxConcurrentRuns,
    defaultModelRouteId,
    auditReadsEnabled,
    traceContentRetentionDays,
    traceContentMode,
  } = fields;

  if (
    Object.values(fields).every((value) => {
      return value === undefined;
    })
  ) {
    ctx.status = 400;
    ctx.body = {
      error:
        'name, guardrail_ids, max_concurrent_runs, default_model_route_id, audit_reads_enabled, trace_content_retention_days, or trace_content_mode is required',
    };
    return;
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
    defaultModelRouteId,
    auditReadsEnabled,
    traceContentRetentionDays,
    traceContentMode,
  });

  ctx.body = project;
});

projectsRouter.delete('/projects/:project_id', async (ctx: Context) => {
  if (!requireAdmin(ctx, 'projects:DeleteProject')) return;

  const force = ctx.query.force === 'true';

  await deleteProject({ id: ctx.params.project_id, force });

  ctx.status = 204;
});

projectsRouter.get('/projects/:project_id/prices', async (ctx: Context) => {
  const projectPublicId = await authorizeProjectPrices({
    ctx,
    action: 'projects:GetProjectPrices',
  });
  if (!projectPublicId) return;

  ctx.body = await listProjectPrices({ projectId: projectPublicId });
});

projectsRouter.put('/projects/:project_id/prices', async (ctx: Context) => {
  const projectPublicId = await authorizeProjectPrices({
    ctx,
    action: 'projects:ManageProjectPrices',
  });
  if (!projectPublicId) return;

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
