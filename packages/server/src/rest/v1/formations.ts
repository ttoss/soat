import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  createFormation,
  deleteFormation,
  detectStaticMetadataViolations,
  type FormationTemplate,
  getFormation,
  getMissingParams,
  listFormationEvents,
  listFormations,
  parseFormationTemplateInput,
  planFormation,
  planResultToWire,
  updateFormation,
  validateFormationTemplateAsync,
} from 'src/lib/formations';
import { buildSrn } from 'src/lib/iam';

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

export const formationsRouter = new Router<Context>();

const missingParamsToErrors = (
  missing: string[]
): { path: string; message: string }[] => {
  return missing.map((name) => {
    return {
      path: `parameters.${name}`,
      message: `Parameter '${name}' is required and cannot be empty`,
    };
  });
};

// Only `template.metadata` resolves at deploy, so an expression here is
// rejected loudly instead of being stored verbatim and never resolved.
const assertStaticMetadata = (metadata: unknown): void => {
  if (metadata === undefined || metadata === null) return;
  const violations = detectStaticMetadataViolations(metadata);
  if (violations.length === 0) return;
  throw new DomainError(
    'FORMATION_INVALID_METADATA',
    `Invalid formation metadata: ${violations
      .map((v) => {
        return v.message;
      })
      .join('; ')}`,
    { details: violations }
  );
};

const assertNoMissingParams = (
  template: FormationTemplate,
  provided: Record<string, string> | undefined,
  forUpdate = false
): void => {
  const missing = getMissingParams(template, provided, forUpdate);
  if (missing.length === 0) return;
  const details = missingParamsToErrors(missing);
  throw new DomainError(
    'FORMATION_MISSING_PARAMETERS',
    `Missing required parameters: ${missing.join(', ')}`,
    { details }
  );
};

formationsRouter.post('/formations/validate', async (ctx: Context) => {
  requireAuth(ctx);

  const body = ctx.request.body as {
    template?: unknown;
    parameters?: Record<string, string>;
  };
  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = await validateFormationTemplateAsync(parsedTemplate);

  if (validation.valid && body.parameters !== undefined) {
    const missing = getMissingParams(
      parsedTemplate as FormationTemplate,
      body.parameters
    );
    if (missing.length > 0) {
      validation.valid = false;
      validation.errors.push(...missingParamsToErrors(missing));
    }
  }

  ctx.body = validation;
});

formationsRouter.post('/formations/plan', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    formation_id?: string;
    template?: unknown;
    parameters?: Record<string, string>;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'formations:PlanFormation',
    resourceType: 'formation',
  });
  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = await validateFormationTemplateAsync(parsedTemplate);
  if (!validation.valid) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid template', {
      details: validation.errors,
    });
  }

  const plan = await planFormation({
    projectId: Number(targetProjectId),
    template: parsedTemplate as FormationTemplate,
    formationId: body.formation_id,
    parameters: body.parameters,
  });
  ctx.body = planResultToWire(plan);
});

formationsRouter.post('/formations', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    name: string;
    template?: unknown;
    metadata?: Record<string, unknown>;
    parameters?: Record<string, string>;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'formations:CreateFormation',
    resourceType: 'formation',
  });
  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = await validateFormationTemplateAsync(parsedTemplate);
  if (!validation.valid) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid template', {
      details: validation.errors,
    });
  }

  assertNoMissingParams(parsedTemplate as FormationTemplate, body.parameters);
  assertStaticMetadata(body.metadata);

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
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'formations:ListFormations',
    resourceType: 'formation',
  });

  ctx.body = await listFormations({
    projectIds: projectIds ?? [],
    ...parsePagination(ctx),
  });
});

formationsRouter.get('/formations/:formation_id', async (ctx: Context) => {
  requireAuth(ctx);

  const formation = await getFormation({ id: ctx.params.formation_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: formation.project_id,
    action: 'formations:GetFormation',
    resource: buildSrn({
      projectPublicId: formation.project_id,
      resourceType: 'formation',
      resourceId: formation.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = formation;
});

formationsRouter.put('/formations/:formation_id', async (ctx: Context) => {
  requireAuth(ctx);

  const formation = await getFormation({ id: ctx.params.formation_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: formation.project_id,
    action: 'formations:UpdateFormation',
    resource: buildSrn({
      projectPublicId: formation.project_id,
      resourceType: 'formation',
      resourceId: formation.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const body = ctx.request.body as {
    template?: unknown;
    metadata?: Record<string, unknown> | null;
    parameters?: Record<string, string>;
  };

  assertStaticMetadata(body.metadata);

  let parsedTemplate: unknown = undefined;
  if (body.template !== undefined) {
    parsedTemplate = parseFormationTemplateInput(body.template);
    const validation = await validateFormationTemplateAsync(parsedTemplate);
    if (!validation.valid) {
      throw new DomainError('VALIDATION_FAILED', 'Invalid template', {
        details: validation.errors,
      });
    }

    assertNoMissingParams(
      parsedTemplate as FormationTemplate,
      body.parameters,
      true
    );
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
  requireAuth(ctx);

  const formation = await getFormation({ id: ctx.params.formation_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: formation.project_id,
    action: 'formations:DeleteFormation',
    resource: buildSrn({
      projectPublicId: formation.project_id,
      resourceType: 'formation',
      resourceId: formation.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const result = await deleteFormation({ id: ctx.params.formation_id });
  ctx.status = 200;
  ctx.body = result;
});

formationsRouter.get(
  '/formations/:formation_id/events',
  async (ctx: Context) => {
    requireAuth(ctx);

    const formation = await getFormation({ id: ctx.params.formation_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: formation.project_id,
      action: 'formations:ListFormationEvents',
      resource: buildSrn({
        projectPublicId: formation.project_id,
        resourceType: 'formation',
        resourceId: formation.id,
      }),
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    ctx.body = await listFormationEvents({
      formationId: ctx.params.formation_id,
      ...parsePagination(ctx),
    });
  }
);
