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

const projectsRouter = new Router<Context>();

type ProjectPriceBody = {
  meterType?: string;
  provider?: string;
  model?: string;
  component?: string;
  unit?: string;
  unitPrice?: number;
  effectiveFrom?: string;
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

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

projectsRouter.patch('/projects/:project_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name : undefined;
  const guardrailIds = parseGuardrailIds(body.guardrailIds);

  if (name === undefined && guardrailIds === undefined) {
    ctx.status = 400;
    ctx.body = { error: 'name or guardrail_ids is required' };
    return;
  }

  if (guardrailIds !== undefined) {
    const current = await getProject({
      id: ctx.params.project_id,
      authUser: ctx.authUser,
    });
    await assertGuardrailDetachAllowed({
      ctx,
      projectPublicId: current.id,
      current: current.guardrailIds,
      next: guardrailIds,
    });
  }

  const project = await updateProject({
    id: ctx.params.project_id,
    name,
    guardrailIds,
  });

  ctx.body = project;
});

projectsRouter.delete('/projects/:project_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

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
      meterType: price.meterType,
      provider: price.provider!,
      model: price.model!,
      component: price.component!,
      unit: price.unit!,
      unitPrice: price.unitPrice!,
      effectiveFrom: price.effectiveFrom!,
    };
  });

  ctx.body = await upsertProjectPrices({ projectId: projectPublicId, prices });
});

export { projectsRouter };
