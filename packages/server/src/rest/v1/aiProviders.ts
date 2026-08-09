import type { AiProviderSlug } from '@soat/postgresdb';
import { AI_PROVIDER_SLUGS } from '@soat/postgresdb';
import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import {
  createAiProvider,
  deleteAiProvider,
  getAiProvider,
  listAiProviders,
  updateAiProvider,
} from 'src/lib/aiProviders';
import { buildSrn } from 'src/lib/iam';
import { listProviderPrices, upsertProviderPrices } from 'src/lib/priceBook';

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

const aiProvidersRouter = new Router<Context>();

type CreateAiProviderBody = {
  project_id?: string;
  secret_id?: string;
  name?: string;
  provider?: string;
  default_model?: string;
  base_url?: string;
  config?: Record<string, unknown>;
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

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'ai-providers:ListAiProviders',
    resourceType: 'aiProvider',
  });

  ctx.body = await listAiProviders({
    projectIds: projectIds ?? [],
    ...parsePagination(ctx),
  });
});

aiProvidersRouter.get('/ai-providers/:ai_provider_id', async (ctx: Context) => {
  requireAuth(ctx);

  const provider = await getAiProvider({ id: ctx.params.ai_provider_id });
  if (!provider) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: provider.project_id!,
    action: 'ai-providers:GetAiProvider',
    resource: buildSrn({
      projectPublicId: provider.project_id!,
      resourceType: 'aiProvider',
      resourceId: provider.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = provider;
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

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: provider.project_id!,
    action,
    resource: buildSrn({
      projectPublicId: provider.project_id!,
      resourceType: 'aiProvider',
      resourceId: provider.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

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
  });

  ctx.status = 201;
  ctx.body = provider;
});

aiProvidersRouter.patch(
  '/ai-providers/:ai_provider_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    const existing = await getAiProvider({ id: ctx.params.ai_provider_id });
    if (!existing) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: existing.project_id!,
      action: 'ai-providers:UpdateAiProvider',
      resource: buildSrn({
        projectPublicId: existing.project_id!,
        resourceType: 'aiProvider',
        resourceId: existing.id,
      }),
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    const body = ctx.request.body as {
      secret_id?: string;
      name?: string;
      provider?: string;
      default_model?: string;
      base_url?: string | null;
      config?: Record<string, unknown> | null;
    };

    let resolvedSecretId: number | undefined;
    if (body.secret_id !== undefined) {
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
    });

    ctx.body = updated;
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

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: existing.project_id!,
      action: 'ai-providers:DeleteAiProvider',
      resource: buildSrn({
        projectPublicId: existing.project_id!,
        resourceType: 'aiProvider',
        resourceId: existing.id,
      }),
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    await deleteAiProvider({
      id: ctx.params.ai_provider_id,
      force: ctx.query.force === 'true',
    });
    ctx.status = 204;
  }
);

export { aiProvidersRouter };
