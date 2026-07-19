import type { AiProviderSlug } from '@soat/postgresdb';
import { AI_PROVIDER_SLUGS } from '@soat/postgresdb';
import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createAiProvider,
  deleteAiProvider,
  getAiProvider,
  listAiProviders,
  updateAiProvider,
} from 'src/lib/aiProviders';
import { buildSrn } from 'src/lib/iam';
import { listProviderPrices, upsertProviderPrices } from 'src/lib/priceBook';

import { checkAuth, resolveWriteProjectId } from './helpers';

const aiProvidersRouter = new Router<Context>();

type CreateAiProviderBody = {
  projectId?: string;
  secretId?: string;
  name?: string;
  provider?: string;
  defaultModel?: string;
  baseUrl?: string;
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'ai-providers:ListAiProviders',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listAiProviders({ projectIds: projectIds ?? [] });
});

aiProvidersRouter.get('/ai-providers/:ai_provider_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const provider = await getAiProvider({ id: ctx.params.ai_provider_id });
  if (!provider) {
    ctx.status = 404;
    ctx.body = { error: 'AI provider not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: provider.projectId!,
    action: 'ai-providers:GetAiProvider',
    resource: buildSrn({
      projectPublicId: provider.projectId!,
      resourceType: 'aiProvider',
      resourceId: provider.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = provider;
});

type ProviderPriceBody = {
  meterType?: string;
  model?: string;
  component?: string;
  unit?: string;
  unitPrice?: number;
  effectiveFrom?: string;
};

// Authorizes a per-provider price request against the provider's own project.
// Returns the resolved provider (mapped) or null when a 401/403/404 response has
// already been set on ctx and the caller should return.
const authorizeProviderPrices = async (args: {
  ctx: Context;
  action: string;
}): Promise<Awaited<ReturnType<typeof getAiProvider>> | null> => {
  const { ctx, action } = args;
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }

  const provider = await getAiProvider({ id: ctx.params.ai_provider_id });
  if (!provider) {
    ctx.status = 404;
    ctx.body = { error: 'AI provider not found' };
    return null;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: provider.projectId!,
    action,
    resource: buildSrn({
      projectPublicId: provider.projectId!,
      resourceType: 'aiProvider',
      resourceId: provider.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
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
        meterType: price.meterType,
        model: price.model!,
        component: price.component!,
        unit: price.unit!,
        unitPrice: price.unitPrice!,
        effectiveFrom: price.effectiveFrom!,
      };
    });

    ctx.body = await upsertProviderPrices({
      aiProviderId: provider.id,
      prices,
    });
  }
);

aiProvidersRouter.post('/ai-providers', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as CreateAiProviderBody;

  const validationError = validateCreateAiProviderBody(body);
  if (validationError) {
    ctx.status = 400;
    ctx.body = { error: validationError };
    return;
  }

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'ai-providers:CreateAiProvider',
  });
  if (targetProjectId === null) return;

  let resolvedSecretId: number | undefined;
  if (body.secretId) {
    const secret = await db.Secret.findOne({
      where: { publicId: body.secretId, projectId: Number(targetProjectId) },
    });
    if (!secret) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid secret ID' };
      return;
    }
    resolvedSecretId = secret.id;
  }

  const provider = await createAiProvider({
    projectId: Number(targetProjectId),
    secretId: resolvedSecretId,
    name: body.name!,
    provider: body.provider as AiProviderSlug,
    defaultModel: body.defaultModel!,
    baseUrl: body.baseUrl,
    config: body.config,
  });

  ctx.status = 201;
  ctx.body = provider;
});

aiProvidersRouter.patch(
  '/ai-providers/:ai_provider_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const existing = await getAiProvider({ id: ctx.params.ai_provider_id });
    if (!existing) {
      ctx.status = 404;
      ctx.body = { error: 'AI provider not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: existing.projectId!,
      action: 'ai-providers:UpdateAiProvider',
      resource: buildSrn({
        projectPublicId: existing.projectId!,
        resourceType: 'aiProvider',
        resourceId: existing.id,
      }),
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const body = ctx.request.body as {
      secretId?: string;
      name?: string;
      provider?: string;
      defaultModel?: string;
      baseUrl?: string | null;
      config?: Record<string, unknown> | null;
    };

    let resolvedSecretId: number | undefined;
    if (body.secretId !== undefined) {
      const project = await db.Project.findOne({
        where: { publicId: existing.projectId! },
      });
      const secret = await db.Secret.findOne({
        where: { publicId: body.secretId, projectId: project!.id },
      });
      if (!secret) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid secret ID' };
        return;
      }
      resolvedSecretId = secret.id;
    }

    const updated = await updateAiProvider({
      id: ctx.params.ai_provider_id,
      secretId: resolvedSecretId,
      name: body.name,
      provider: body.provider as AiProviderSlug | undefined,
      defaultModel: body.defaultModel,
      baseUrl: body.baseUrl,
      config: body.config,
    });

    ctx.body = updated;
  }
);

aiProvidersRouter.delete(
  '/ai-providers/:ai_provider_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const existing = await getAiProvider({ id: ctx.params.ai_provider_id });
    if (!existing) {
      ctx.status = 404;
      ctx.body = { error: 'AI provider not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: existing.projectId!,
      action: 'ai-providers:DeleteAiProvider',
      resource: buildSrn({
        projectPublicId: existing.projectId!,
        resourceType: 'aiProvider',
        resourceId: existing.id,
      }),
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    await deleteAiProvider({
      id: ctx.params.ai_provider_id,
      force: ctx.query.force === 'true',
    });
    ctx.status = 204;
  }
);

export { aiProvidersRouter };
