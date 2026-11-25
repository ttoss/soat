import type { AiProviderSlug } from '@soat/postgresdb';
import { AI_PROVIDER_SLUGS } from '@soat/postgresdb';
import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { redactAiProviderSecrets } from 'src/lib/aiProviderConfigSecrets';
import { deleteAiProvider } from 'src/lib/aiProviderDeletion';
import type { ModelAliases } from 'src/lib/aiProviderModelAliases';
import { listAiProviderModels } from 'src/lib/aiProviderModelListing';
import {
  createAiProvider,
  getAiProvider,
  listAiProviders,
  updateAiProvider,
} from 'src/lib/aiProviders';
import { buildSrn } from 'src/lib/iam';
import type { ModelInputLimits } from 'src/lib/inputLimits';
import type { ModelInputModalities } from 'src/lib/inputModalityGate';
import { listProviderPrices, upsertProviderPrices } from 'src/lib/priceBook';
import { getShareProjection } from 'src/lib/shareableTypes';

import { parsePagination, requireAuth, resolveWriteProjectId } from './helpers';
import { resolveListScope } from './listScope';
import { requireAllowed } from './resourceAccess';
import { authorizeSharedUse } from './sharedAccess';

const aiProvidersRouter = new Router<Context>();

type CreateAiProviderBody = {
  project_id?: string;
  secret_id?: string;
  name?: string;
  provider?: string;
  default_model?: string;
  base_url?: string;
  config?: Record<string, unknown>;
  model_aliases?: ModelAliases;
  model_aliases_only?: boolean;
  model_input_modalities?: ModelInputModalities;
  model_input_limits?: ModelInputLimits;
  require_priced_model?: boolean;
};

const validateCreateAiProviderBody = (
  body: CreateAiProviderBody
): string | null => {
  if (
    !body.provider ||
    !AI_PROVIDER_SLUGS.includes(body.provider as AiProviderSlug)
  ) {
    return `provider must be one of: ${AI_PROVIDER_SLUGS.join(', ')}`;
  }
  return null;
};

aiProvidersRouter.get('/ai-providers', async (ctx: Context) => {
  requireAuth(ctx);

  const { projectIds } = await resolveListScope({
    ctx,
    action: 'ai-providers:ListAiProviders',
    resourceType: 'aiProvider',
    projectSelector: 'optional',
  });

  const page = await listAiProviders({
    projectIds,
    ...parsePagination(ctx),
  });
  ctx.body = { ...page, data: page.data.map(redactAiProviderSecrets) };
});

aiProvidersRouter.get('/ai-providers/:ai_provider_id', async (ctx: Context) => {
  const shared = await authorizeSharedUse({
    ctx,
    resourceType: 'aiProvider',
    resourceId: ctx.params.ai_provider_id,
    action: 'ai-providers:GetAiProvider',
  });
  if (shared) {
    ctx.body = await getShareProjection({
      resourceType: 'aiProvider',
      id: ctx.params.ai_provider_id,
      ownerProjectId: shared.ownerProjectId,
    });
    return;
  }
  requireAuth(ctx);

  const provider = await getAiProvider({ id: ctx.params.ai_provider_id });
  if (!provider) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
  }

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: provider.project_id!,
      action: 'ai-providers:GetAiProvider',
      resource: buildSrn({
        projectPublicId: provider.project_id!,
        resourceType: 'aiProvider',
        resourceId: provider.id,
      }),
    },
    notFound: new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found'),
  });

  ctx.body = redactAiProviderSecrets(provider);
});

type ProviderPriceBody = {
  meter_type?: string;
  model?: string;
  component?: string;
  unit?: string;
  unit_price?: number;
  effective_from?: string;
};

// Authorizes a per-provider price request against the provider's own project.
// Returns the resolved provider (mapped) or null when a 401/403/404 response has
// already been set on ctx and the caller should return.
const authorizeProviderPrices = async (args: {
  ctx: Context;
  action: string;
}): Promise<Awaited<ReturnType<typeof getAiProvider>> | null> => {
  const { ctx, action } = args;
  requireAuth(ctx);

  const provider = await getAiProvider({ id: ctx.params.ai_provider_id });
  if (!provider) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
  }

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: provider.project_id!,
      action,
      resource: buildSrn({
        projectPublicId: provider.project_id!,
        resourceType: 'aiProvider',
        resourceId: provider.id,
      }),
    },
    notFound: new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found'),
  });

  return provider;
};

aiProvidersRouter.get(
  '/ai-providers/:ai_provider_id/prices',
  async (ctx: Context) => {
    const provider = await authorizeProviderPrices({
      ctx,
      action: 'ai-providers:GetAiProviderPrices',
    });
    if (!provider) return;

    ctx.body = await listProviderPrices({ aiProviderId: provider.id });
  }
);

aiProvidersRouter.put(
  '/ai-providers/:ai_provider_id/prices',
  async (ctx: Context) => {
    const provider = await authorizeProviderPrices({
      ctx,
      action: 'ai-providers:ManageAiProviderPrices',
    });
    if (!provider) return;

    const body = ctx.request.body as { prices?: ProviderPriceBody[] };
    const prices = (body.prices ?? []).map((price) => {
      return {
        meterType: price.meter_type,
        model: price.model!,
        component: price.component!,
        unit: price.unit!,
        unitPrice: price.unit_price!,
        effectiveFrom: price.effective_from!,
      };
    });

    ctx.body = await upsertProviderPrices({
      aiProviderId: provider.id,
      prices,
    });
  }
);

aiProvidersRouter.post('/ai-providers', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as CreateAiProviderBody;

  const validationError = validateCreateAiProviderBody(body);
  if (validationError) {
    throw new DomainError('VALIDATION_FAILED', validationError);
  }

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'ai-providers:CreateAiProvider',
    resourceType: 'aiProvider',
  });
  let resolvedSecretId: number | undefined;
  if (body.secret_id) {
    const secret = await db.Secret.findOne({
      where: { publicId: body.secret_id, projectId: Number(targetProjectId) },
    });
    if (!secret) {
      throw new DomainError('VALIDATION_FAILED', 'Invalid secret ID');
    }
    resolvedSecretId = secret.id;
  }

  const provider = await createAiProvider({
    projectId: Number(targetProjectId),
    secretId: resolvedSecretId,
    name: body.name!,
    provider: body.provider as AiProviderSlug,
    defaultModel: body.default_model!,
    baseUrl: body.base_url,
    config: body.config,
    modelAliases: body.model_aliases,
    modelAliasesOnly: body.model_aliases_only,
    modelInputModalities: body.model_input_modalities,
    modelInputLimits: body.model_input_limits,
    requirePricedModel: body.require_priced_model,
    isAllowed: ctx.authUser.isAllowed,
  });

  ctx.status = 201;
  ctx.body = redactAiProviderSecrets(provider);
});

aiProvidersRouter.patch(
  '/ai-providers/:ai_provider_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    const existing = await getAiProvider({ id: ctx.params.ai_provider_id });
    if (!existing) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
    }

    await requireAllowed({
      ctx,
      check: {
        projectPublicId: existing.project_id!,
        action: 'ai-providers:UpdateAiProvider',
        resource: buildSrn({
          projectPublicId: existing.project_id!,
          resourceType: 'aiProvider',
          resourceId: existing.id,
        }),
      },
      notFound: new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found'),
    });

    const body = ctx.request.body as {
      secret_id?: string | null;
      name?: string;
      provider?: string;
      default_model?: string;
      base_url?: string | null;
      config?: Record<string, unknown> | null;
      model_aliases?: ModelAliases | null;
      model_aliases_only?: boolean;
      model_input_modalities?: ModelInputModalities | null;
      model_input_limits?: ModelInputLimits | null;
      require_priced_model?: boolean;
    };

    let resolvedSecretId: number | null | undefined =
      body.secret_id === null ? null : undefined;
    if (typeof body.secret_id === 'string') {
      const project = await db.Project.findOne({
        where: { publicId: existing.project_id! },
      });
      const secret = await db.Secret.findOne({
        where: { publicId: body.secret_id, projectId: project!.id },
      });
      if (!secret) {
        throw new DomainError('VALIDATION_FAILED', 'Invalid secret ID');
      }
      resolvedSecretId = secret.id;
    }

    const updated = await updateAiProvider({
      id: ctx.params.ai_provider_id,
      secretId: resolvedSecretId,
      name: body.name,
      provider: body.provider as AiProviderSlug | undefined,
      defaultModel: body.default_model,
      baseUrl: body.base_url,
      config: body.config,
      modelAliases: body.model_aliases,
      modelAliasesOnly: body.model_aliases_only,
      modelInputModalities: body.model_input_modalities,
      modelInputLimits: body.model_input_limits,
      requirePricedModel: body.require_priced_model,
      isAllowed: ctx.authUser.isAllowed,
    });

    ctx.body = updated && redactAiProviderSecrets(updated);
  }
);

aiProvidersRouter.get(
  '/ai-providers/:ai_provider_id/models',
  async (ctx: Context) => {
    requireAuth(ctx);

    const existing = await getAiProvider({ id: ctx.params.ai_provider_id });
    if (!existing) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
    }

    await requireAllowed({
      ctx,
      check: {
        projectPublicId: existing.project_id!,
        action: 'ai-providers:ListAiProviderModels',
        resource: buildSrn({
          projectPublicId: existing.project_id!,
          resourceType: 'aiProvider',
          resourceId: existing.id,
        }),
      },
      notFound: new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found'),
    });

    ctx.body = await listAiProviderModels({
      aiProviderId: ctx.params.ai_provider_id,
      q: typeof ctx.query.q === 'string' ? ctx.query.q : undefined,
      ...parsePagination(ctx),
    });
  }
);

aiProvidersRouter.delete(
  '/ai-providers/:ai_provider_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    const existing = await getAiProvider({ id: ctx.params.ai_provider_id });
    if (!existing) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
    }

    await requireAllowed({
      ctx,
      check: {
        projectPublicId: existing.project_id!,
        action: 'ai-providers:DeleteAiProvider',
        resource: buildSrn({
          projectPublicId: existing.project_id!,
          resourceType: 'aiProvider',
          resourceId: existing.id,
        }),
      },
      notFound: new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found'),
    });

    await deleteAiProvider({
      id: ctx.params.ai_provider_id,
      force: ctx.query.force === 'true',
    });
    ctx.status = 204;
  }
);

export { aiProvidersRouter };
