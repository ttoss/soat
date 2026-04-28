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
  if (!body.name) return 'name is required';
  if (
    !body.provider ||
    !AI_PROVIDER_SLUGS.includes(body.provider as AiProviderSlug)
  ) {
    return `provider must be one of: ${AI_PROVIDER_SLUGS.join(', ')}`;
  }
  if (!body.defaultModel) return 'defaultModel is required';
  return null;
};

const resolveAiProviderProjectPublicId = (
  body: CreateAiProviderBody,
  authUser: NonNullable<Context['authUser']>
): string | null => {
  if (body.projectId) return body.projectId;
  if (authUser.apiKeyProjectPublicId) return authUser.apiKeyProjectPublicId;
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
    action: 'aiProviders:ListAiProviders',
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
    action: 'aiProviders:GetAiProvider',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = provider;
});

aiProvidersRouter.post('/ai-providers', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as CreateAiProviderBody;

  const validationError = validateCreateAiProviderBody(body);
  if (validationError) {
    ctx.status = 400;
    ctx.body = { error: validationError };
    return;
  }

  const resolvedProjectPublicId = resolveAiProviderProjectPublicId(
    body,
    ctx.authUser
  );
  if (!resolvedProjectPublicId) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: resolvedProjectPublicId,
    action: 'aiProviders:CreateAiProvider',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
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

  let resolvedSecretId: number | undefined;
  if (body.secretId) {
    const secret = await db.Secret.findOne({
      where: { publicId: body.secretId, projectId: project.id },
    });
    if (!secret) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid secret ID' };
      return;
    }
    resolvedSecretId = secret.id;
  }

  const provider = await createAiProvider({
    projectId: project.id,
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

aiProvidersRouter.patch('/ai-providers/:ai_provider_id', async (ctx: Context) => {
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
    action: 'aiProviders:UpdateAiProvider',
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
});

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
      action: 'aiProviders:DeleteAiProvider',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    await deleteAiProvider({ id: ctx.params.ai_provider_id });
    ctx.status = 204;
  }
);

export { aiProvidersRouter };
