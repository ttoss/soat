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
  updateFormation,
  validateFormationTemplate,
} from 'src/lib/formations';
import { buildSrn } from 'src/lib/iam';

import { checkAuth, resolveWriteProjectId } from './helpers';

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

// The formation-level `metadata` field is a static annotation bag, not a
// substitution site (only `template.metadata` resolves at deploy). Reject any
// `sub`/`param`/`ref` expression here so it fails loudly instead of being
// stored verbatim and silently never resolved (F-16).
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    template?: unknown;
    parameters?: Record<string, string>;
  };
  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = validateFormationTemplate(parsedTemplate);

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
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    formationId?: string;
    template?: unknown;
    parameters?: Record<string, string>;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'formations:PlanFormation',
    resourceType: 'formation',
  });
  if (targetProjectId === null) return;

  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = validateFormationTemplate(parsedTemplate);
  if (!validation.valid) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid template', details: validation.errors };
    return;
  }

  ctx.body = await planFormation({
    projectId: Number(targetProjectId),
    template: parsedTemplate as FormationTemplate,
    formationId: body.formationId,
    parameters: body.parameters,
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
    resourceType: 'formation',
  });
  if (targetProjectId === null) return;

  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = validateFormationTemplate(parsedTemplate);
  if (!validation.valid) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid template', details: validation.errors };
    return;
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'formations:ListFormations',
    resourceType: 'formation',
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
    resource: buildSrn({
      projectPublicId: formation.projectId,
      resourceType: 'formation',
      resourceId: formation.id,
    }),
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
    resource: buildSrn({
      projectPublicId: formation.projectId,
      resourceType: 'formation',
      resourceId: formation.id,
    }),
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

  assertStaticMetadata(body.metadata);

  let parsedTemplate: unknown = undefined;
  if (body.template !== undefined) {
    parsedTemplate = parseFormationTemplateInput(body.template);
    const validation = validateFormationTemplate(parsedTemplate);
    if (!validation.valid) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid template', details: validation.errors };
      return;
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const formation = await getFormation({ id: ctx.params.formation_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: formation.projectId,
    action: 'formations:DeleteFormation',
    resource: buildSrn({
      projectPublicId: formation.projectId,
      resourceType: 'formation',
      resourceId: formation.id,
    }),
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
      resource: buildSrn({
        projectPublicId: formation.projectId,
        resourceType: 'formation',
        resourceId: formation.id,
      }),
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
