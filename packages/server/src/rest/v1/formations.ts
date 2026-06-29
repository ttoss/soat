import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
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

import { checkAuth, resolveWriteProjectId } from './helpers';

export const formationsRouter = new Router<Context>();

const buildMissingParamsError = (
  template: FormationTemplate,
  provided: Record<string, string> | undefined,
  usePrevious?: string[]
): { error: string; details: { path: string; message: string }[] } | null => {
  const missing = getMissingParams(template, provided, usePrevious);
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

/**
 * A parameter may either be supplied a value or flagged "use previous value",
 * never both — mirroring CloudFormation's mutual exclusivity of `ParameterValue`
 * and `UsePreviousValue`. Returns an error payload, or null when valid.
 */
const buildParamConflictError = (
  provided: Record<string, string> | undefined,
  usePrevious: string[] | undefined
): { error: string; details: { path: string; message: string }[] } | null => {
  if (!usePrevious || usePrevious.length === 0) return null;
  const conflicts = usePrevious.filter((name) => {
    return provided?.[name] !== undefined;
  });
  if (conflicts.length === 0) return null;
  return {
    error:
      'A parameter cannot be both supplied and kept (parameters_use_previous)',
    details: conflicts.map((name) => {
      return {
        path: `parameters.${name}`,
        message: `Parameter '${name}' is given a value and also listed in parameters_use_previous`,
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
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    formationId?: string;
    template?: unknown;
    parameters?: Record<string, string>;
    parametersUsePrevious?: string[];
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'formations:PlanFormation',
  });
  if (targetProjectId === null) return;

  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = validateFormationTemplate(parsedTemplate);
  if (!validation.valid) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid template', details: validation.errors };
    return;
  }

  const conflictError = buildParamConflictError(
    body.parameters,
    body.parametersUsePrevious
  );
  if (conflictError) {
    ctx.status = 400;
    ctx.body = conflictError;
    return;
  }

  ctx.body = await planFormation({
    projectId: Number(targetProjectId),
    template: parsedTemplate as FormationTemplate,
    formationId: body.formationId,
    parameters: body.parameters,
    parametersUsePrevious: body.parametersUsePrevious,
  });
});

formationsRouter.post('/formations', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    name: string;
    template?: unknown;
    metadata?: Record<string, unknown>;
    parameters?: Record<string, string>;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'formations:CreateFormation',
  });
  if (targetProjectId === null) return;

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

  const result = await createFormation({
    projectId: Number(targetProjectId),
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
    parametersUsePrevious?: string[];
  };

  const conflictError = buildParamConflictError(
    body.parameters,
    body.parametersUsePrevious
  );
  if (conflictError) {
    ctx.status = 400;
    ctx.body = conflictError;
    return;
  }

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
      body.parameters,
      body.parametersUsePrevious
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
    parametersUsePrevious: body.parametersUsePrevious,
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

  const result = await deleteFormation({ id: ctx.params.formation_id });
  ctx.status = 200;
  ctx.body = result;
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
