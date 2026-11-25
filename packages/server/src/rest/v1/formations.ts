import { Router } from '@ttoss/http-server';
import type { AuthUser, Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { callerPrincipal, requestRefusal } from 'src/lib/authorizationDenial';
import {
  createFormation,
  deleteFormation,
  detectStaticMetadataViolations,
  type FormationActor,
  type FormationAuthorizer,
  type FormationTemplate,
  getFormation,
  listFormationEvents,
  listFormations,
  parseFormationTemplateInput,
  planFormation,
  planResultToWire,
  updateFormation,
  validateFormationTemplateAsync,
} from 'src/lib/formations';
import { deployableTemplate } from 'src/lib/formationsDeployTemplate';
import { missingParameterErrors } from 'src/lib/formationsHelpers';
import { parameterValueErrors } from 'src/lib/formationsParameters';
import type { FormationAuthorizationRequest } from 'src/lib/formationsTypes';
import { buildSrn } from 'src/lib/iam';
import { namesRequestTag } from 'src/lib/iamConditionKeys';
import { readNullableMetadataBag } from 'src/lib/metadataBag';
import { buildRequestTagContext } from 'src/lib/tags';
import { admitAuthorized } from 'src/middleware/admission';
import { recordAuthorizationDecision } from 'src/middleware/audit';

import {
  parsePagination,
  requestPrincipalFromCtx,
  requireAuth,
  requireCallerUser,
  resolveWriteProjectId,
  resolveWriteProjectPublicId,
} from './helpers';
import { resolveListScope } from './listScope';
import { requireAllowed } from './resourceAccess';

export const formationsRouter = new Router<Context>();

/**
 * A tag whose value is computed is known only after this check, so a policy
 * conditioning on that key cannot be evaluated: the write is refused rather
 * than letting the condition read an absent key.
 */
const writesUnknownRequestTag = async (args: {
  ctx: Context & { authUser: AuthUser };
  projectPublicId: string;
  request: FormationAuthorizationRequest;
}): Promise<boolean> => {
  const keys = args.request.computedRequestTagKeys ?? [];
  if (keys.length === 0) return false;
  return namesRequestTag({
    sets: await args.ctx.authUser.getPolicies(args.projectPublicId),
    keys,
  });
};

/**
 * Answers the per-resource authorization questions the deploy path asks, for
 * one request and one project.
 *
 * A closure rather than a threaded `Context`: the lib layer stays free of the
 * request, and every decision is recorded here — a Deny that silently failed to
 * apply left no audit entry distinguishing it from a Deny that was honoured,
 * which is what made the gap invisible.
 */
const formationAuthorizer = (args: {
  ctx: Context & { authUser: AuthUser };
  projectPublicId: string;
}): FormationAuthorizer => {
  const { authUser } = args.ctx;
  return {
    check: async (request) => {
      const resource = buildSrn({
        projectPublicId: args.projectPublicId,
        resourceType: request.srnResourceType,
        resourceId: request.resourceId,
      });
      const unknownTag = await writesUnknownRequestTag({ ...args, request });
      const allowed =
        !unknownTag &&
        (await authUser.isAllowed({
          projectPublicId: args.projectPublicId,
          action: request.action,
          resource,
          context: buildRequestTagContext(request.requestTags ?? {}),
        }));

      recordAuthorizationDecision(args.ctx, {
        action: request.action,
        allowed,
      });

      if (allowed) return { allowed, resource };
      return {
        allowed,
        resource,
        refusal: unknownTag
          ? { principal: callerPrincipal(authUser), denial: null }
          : requestRefusal({ authUser, action: request.action, resource }),
      };
    },
  };
};

/** The deploying caller: the account it acts for and the credential itself. */
const formationActorOf = (
  ctx: Context & { authUser: AuthUser }
): FormationActor => {
  return {
    userId: requireCallerUser(ctx, 'formations:CreateFormation').id,
    author: requestPrincipalFromCtx(ctx),
    isAllowed: ctx.authUser.isAllowed,
    getPolicies: ctx.authUser.getPolicies,
    getLabeledPolicies: ctx.authUser.getLabeledPolicies,
    iamToken: ctx.authUser.iamToken,
    onBehalfOfPrincipal: ctx.authUser.onBehalfOfPrincipal,
    keyPolicyBoundary: ctx.authUser.apiKeyPolicyIds,
    narrowed: ctx.authUser.narrowing === 'beyond_key',
    unrestricted: ctx.authUser.unrestricted,
    recordRefusal: (action) => {
      recordAuthorizationDecision(ctx, { action, allowed: false });
    },
  };
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

formationsRouter.post('/formations/validate', async (ctx: Context) => {
  requireAuth(ctx);
  await admitAuthorized(ctx, 'formations:ValidateFormation');

  const body = ctx.request.body as {
    template?: unknown;
    parameters?: Record<string, string>;
  };
  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = await validateFormationTemplateAsync({
    template: parsedTemplate,
    projectPublicId: null,
  });

  if (validation.valid && body.parameters !== undefined) {
    const errors = [
      ...missingParameterErrors({
        template: parsedTemplate as FormationTemplate,
        provided: body.parameters,
        forUpdate: false,
      }),
      ...parameterValueErrors(
        parsedTemplate as FormationTemplate,
        body.parameters
      ),
    ];
    if (errors.length > 0) {
      validation.valid = false;
      validation.errors.push(...errors);
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
  const projectPublicId = resolveWriteProjectPublicId({
    ctx,
    projectPublicId: body.project_id,
  });
  const parsedTemplate = await deployableTemplate({
    input: body.template,
    parameters: body.parameters,
    projectPublicId,
    stored: {
      formationId: body.formation_id,
      projectId: Number(targetProjectId),
    },
  });

  const plan = await planFormation({
    projectId: Number(targetProjectId),
    template: parsedTemplate,
    formationId: body.formation_id,
    parameters: body.parameters,
    authorize: formationAuthorizer({ ctx, projectPublicId }),
  });
  ctx.body = planResultToWire(plan);
});

formationsRouter.post('/formations', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    name: string;
    template?: unknown;
    metadata?: unknown;
    parameters?: Record<string, string>;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'formations:CreateFormation',
    resourceType: 'formation',
  });
  const projectPublicId = resolveWriteProjectPublicId({
    ctx,
    projectPublicId: body.project_id,
  });
  const parsedTemplate = await deployableTemplate({
    input: body.template,
    parameters: body.parameters,
    projectPublicId,
  });
  const metadata = readNullableMetadataBag(body.metadata);
  assertStaticMetadata(metadata);

  const result = await createFormation({
    projectId: Number(targetProjectId),
    name: body.name,
    template: parsedTemplate as FormationTemplate,
    metadata: metadata ?? undefined,
    parameters: body.parameters,
    authorize: formationAuthorizer({ ctx, projectPublicId }),
    actor: formationActorOf(ctx),
  });

  ctx.status = 201;
  ctx.body = result;
});

formationsRouter.get('/formations', async (ctx: Context) => {
  requireAuth(ctx);

  const { projectIds } = await resolveListScope({
    ctx,
    action: 'formations:ListFormations',
    resourceType: 'formation',
    projectSelector: 'optional',
  });

  ctx.body = await listFormations({
    projectIds,
    ...parsePagination(ctx),
  });
});

formationsRouter.get('/formations/:formation_id', async (ctx: Context) => {
  requireAuth(ctx);

  const formation = await getFormation({ id: ctx.params.formation_id });

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: formation.project_id,
      action: 'formations:GetFormation',
      resource: buildSrn({
        projectPublicId: formation.project_id,
        resourceType: 'formation',
        resourceId: formation.id,
      }),
    },
    notFound: new DomainError(
      'RESOURCE_NOT_FOUND',
      `Formation '${ctx.params.formation_id}' not found.`
    ),
  });

  ctx.body = formation;
});

formationsRouter.put('/formations/:formation_id', async (ctx: Context) => {
  requireAuth(ctx);

  const formation = await getFormation({ id: ctx.params.formation_id });

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: formation.project_id,
      action: 'formations:UpdateFormation',
      resource: buildSrn({
        projectPublicId: formation.project_id,
        resourceType: 'formation',
        resourceId: formation.id,
      }),
    },
    notFound: new DomainError(
      'RESOURCE_NOT_FOUND',
      `Formation '${ctx.params.formation_id}' not found.`
    ),
  });

  const body = ctx.request.body as {
    template?: unknown;
    metadata?: unknown;
    parameters?: Record<string, string>;
  };

  const metadata = readNullableMetadataBag(body.metadata);
  assertStaticMetadata(metadata);

  const parsedTemplate = await deployableTemplate({
    input: body.template,
    parameters: body.parameters,
    projectPublicId: formation.project_id,
    stored: { formationId: formation.id },
  });

  const updated = await updateFormation({
    id: ctx.params.formation_id,
    template: parsedTemplate,
    metadata,
    parameters: body.parameters,
    authorize: formationAuthorizer({
      ctx,
      projectPublicId: formation.project_id,
    }),
    actor: formationActorOf(ctx),
  });

  ctx.body = updated;
});

formationsRouter.delete('/formations/:formation_id', async (ctx: Context) => {
  requireAuth(ctx);

  const formation = await getFormation({ id: ctx.params.formation_id });

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: formation.project_id,
      action: 'formations:DeleteFormation',
      resource: buildSrn({
        projectPublicId: formation.project_id,
        resourceType: 'formation',
        resourceId: formation.id,
      }),
    },
    notFound: new DomainError(
      'RESOURCE_NOT_FOUND',
      `Formation '${ctx.params.formation_id}' not found.`
    ),
  });

  const result = await deleteFormation({
    id: ctx.params.formation_id,
    authorize: formationAuthorizer({
      ctx,
      projectPublicId: formation.project_id,
    }),
    actor: formationActorOf(ctx),
  });
  ctx.status = 200;
  ctx.body = result;
});

formationsRouter.get(
  '/formations/:formation_id/events',
  async (ctx: Context) => {
    requireAuth(ctx);

    const formation = await getFormation({ id: ctx.params.formation_id });

    await requireAllowed({
      ctx,
      check: {
        projectPublicId: formation.project_id,
        action: 'formations:ListFormationEvents',
        resource: buildSrn({
          projectPublicId: formation.project_id,
          resourceType: 'formation',
          resourceId: formation.id,
        }),
      },
      notFound: new DomainError(
        'RESOURCE_NOT_FOUND',
        `Formation '${ctx.params.formation_id}' not found.`
      ),
    });

    ctx.body = await listFormationEvents({
      formationId: ctx.params.formation_id,
      ...parsePagination(ctx),
    });
  }
);
