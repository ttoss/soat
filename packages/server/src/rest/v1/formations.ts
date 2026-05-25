import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createFormation,
  deleteFormation,
  type FormationTemplate,
  getFormation,
  getMissingParams,
  listFormationEvents,
  listFormations,
  parseFormationTemplateInput,
  planFormation,
  updateFormation,
  validateFormationTemplate,
} from 'src/lib/formations';

export const formationsRouter = new Router<Context>();

const resolveProjectPublicId = (
  body: { projectId?: string },
  apiKeyProjectPublicId: string | null | undefined
): string | null => {
  if (body.projectId) {
    return body.projectId;
  }
  if (apiKeyProjectPublicId) {
    return apiKeyProjectPublicId;
  }
  return null;
};

const buildMissingParamsError = (
  template: FormationTemplate,
  provided: Record<string, string> | undefined
): { error: string; details: { path: string; message: string }[] } | null => {
  const missing = getMissingParams(template, provided);
  if (missing.length === 0) return null;
  return {
    error: 'Missing required parameters',
    details: missing.map((name) => {
      return {
        path: `parameters.${name}`,
        message: `Parameter '${name}' is required and cannot be empty`,
      };
    }),
  };
};

formationsRouter.post('/formations/validate', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as { template?: unknown };
  const parsedTemplate = parseFormationTemplateInput(body.template);
  ctx.body = validateFormationTemplate(parsedTemplate);
});

formationsRouter.post('/formations/plan', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    formationId?: string;
    template?: unknown;
    parameters?: Record<string, string>;
  };

  const resolvedProjectPublicId = resolveProjectPublicId(
    body,
    ctx.authUser.apiKeyProjectPublicId
  );
  if (!resolvedProjectPublicId) {
    ctx.status = 400;
    ctx.body = { error: 'project_id is required' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: resolvedProjectPublicId,
    action: 'formations:PlanFormation',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = validateFormationTemplate(parsedTemplate);
  if (!validation.valid) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid template', details: validation.errors };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: resolvedProjectPublicId },
  });
  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project ID' };
    return;
  }

  ctx.body = await planFormation({
    projectId: project.id,
    template: parsedTemplate as FormationTemplate,
    formationId: body.formationId,
    parameters: body.parameters,
  });
});

formationsRouter.post('/formations', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    name?: string;
    template?: unknown;
    metadata?: Record<string, unknown>;
    parameters?: Record<string, string>;
  };

  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  const resolvedProjectPublicId = resolveProjectPublicId(
    body,
    ctx.authUser.apiKeyProjectPublicId
  );
  if (!resolvedProjectPublicId) {
    ctx.status = 400;
    ctx.body = { error: 'project_id is required' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: resolvedProjectPublicId,
    action: 'formations:CreateFormation',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = validateFormationTemplate(parsedTemplate);
  if (!validation.valid) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid template', details: validation.errors };
    return;
  }

  const missingParamsError = buildMissingParamsError(
    parsedTemplate as FormationTemplate,
    body.parameters
  );
  if (missingParamsError) {
    ctx.status = 400;
    ctx.body = missingParamsError;
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: resolvedProjectPublicId },
  });
  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project ID' };
    return;
  }

  const result = await createFormation({
    projectId: project.id,
    name: body.name,
    template: parsedTemplate as FormationTemplate,
    metadata: body.metadata,
    parameters: body.parameters,
  });

  ctx.status = 201;
  ctx.body = result;
});

formationsRouter.get('/formations', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'formations:ListFormations',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listFormations({ projectIds: projectIds ?? [] });
});

formationsRouter.get('/formations/:formation_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const formation = await getFormation({ id: ctx.params.formation_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: formation.projectId,
    action: 'formations:GetFormation',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = formation;
});

formationsRouter.put('/formations/:formation_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const formation = await getFormation({ id: ctx.params.formation_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: formation.projectId,
    action: 'formations:UpdateFormation',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    template?: unknown;
    metadata?: Record<string, unknown> | null;
    parameters?: Record<string, string>;
  };

  let parsedTemplate: unknown = undefined;
  if (body.template !== undefined) {
    parsedTemplate = parseFormationTemplateInput(body.template);
    const validation = validateFormationTemplate(parsedTemplate);
    if (!validation.valid) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid template', details: validation.errors };
      return;
    }

    const missingParamsError = buildMissingParamsError(
      parsedTemplate as FormationTemplate,
      body.parameters
    );
    if (missingParamsError) {
      ctx.status = 400;
      ctx.body = missingParamsError;
      return;
    }
  }

  const updated = await updateFormation({
    id: ctx.params.formation_id,
    template: parsedTemplate as FormationTemplate | undefined,
    metadata: body.metadata,
    parameters: body.parameters,
  });

  ctx.body = updated;
});

formationsRouter.delete('/formations/:formation_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const formation = await getFormation({ id: ctx.params.formation_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: formation.projectId,
    action: 'formations:DeleteFormation',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteFormation({ id: ctx.params.formation_id });
  ctx.status = 204;
});

formationsRouter.get(
  '/formations/:formation_id/events',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const formation = await getFormation({ id: ctx.params.formation_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: formation.projectId,
      action: 'formations:ListFormationEvents',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    ctx.body = await listFormationEvents({
      formationId: ctx.params.formation_id,
    });
  }
);
