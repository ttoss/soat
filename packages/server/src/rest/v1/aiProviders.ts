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

/**
 * @openapi
 * /ai-providers:
 *   get:
 *     tags:
 *       - AI Providers
 *     summary: List AI providers
 *     description: Returns all AI providers in the project.
 *     operationId: listAiProviders
 *     parameters:
 *       - name: projectId
 *         in: query
 *         required: false
 *         description: Project ID
 *         schema:
 *           type: string
 *           example: 'proj_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: List of AI providers
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AiProviderRecord'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @openapi
 * /ai-providers/{aiProviderId}:
 *   get:
 *     tags:
 *       - AI Providers
 *     summary: Get an AI provider by ID
 *     description: Returns AI provider details. The secret value is never returned.
 *     operationId: getAiProvider
 *     parameters:
 *       - name: aiProviderId
 *         in: path
 *         required: true
 *         description: AI Provider ID
 *         schema:
 *           type: string
 *           example: 'aip_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: AI provider found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AiProviderRecord'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: AI provider not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
aiProvidersRouter.get('/ai-providers/:aiProviderId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const provider = await getAiProvider({ id: ctx.params.aiProviderId });
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

/**
 * @openapi
 * /ai-providers:
 *   post:
 *     tags:
 *       - AI Providers
 *     summary: Create an AI provider
 *     description: Creates a new AI provider configuration.
 *     operationId: createAiProvider
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - provider
 *               - defaultModel
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project ID. Required for JWT auth; omit when using a project key.
 *                 example: 'proj_V1StGXR8Z5jdHi6B'
 *               secretId:
 *                 type: string
 *                 description: Secret ID containing the provider credentials
 *                 example: 'sec_V1StGXR8Z5jdHi6B'
 *               name:
 *                 type: string
 *                 example: 'OpenAI Production'
 *               provider:
 *                 type: string
 *                 enum: [openai, anthropic, google, xai, groq, ollama, azure, bedrock, gateway, custom]
 *                 example: 'openai'
 *               defaultModel:
 *                 type: string
 *                 example: 'gpt-4o'
 *               baseUrl:
 *                 type: string
 *                 example: 'https://api.openai.com/v1'
 *               config:
 *                 type: object
 *                 description: Provider-specific configuration
 *     responses:
 *       '201':
 *         description: AI provider created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AiProviderRecord'
 *       '400':
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
aiProvidersRouter.post('/ai-providers', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    secretId?: string;
    name?: string;
    provider?: string;
    defaultModel?: string;
    baseUrl?: string;
    config?: Record<string, unknown>;
  };

  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }
  if (
    !body.provider ||
    !AI_PROVIDER_SLUGS.includes(body.provider as AiProviderSlug)
  ) {
    ctx.status = 400;
    ctx.body = {
      error: `provider must be one of: ${AI_PROVIDER_SLUGS.join(', ')}`,
    };
    return;
  }
  if (!body.defaultModel) {
    ctx.status = 400;
    ctx.body = { error: 'defaultModel is required' };
    return;
  }

  let resolvedProjectPublicId = body.projectId;
  if (!resolvedProjectPublicId) {
    if (ctx.authUser.projectKeyProjectId) {
      resolvedProjectPublicId = ctx.authUser.projectKeyProjectId;
    } else {
      ctx.status = 400;
      ctx.body = { error: 'projectId is required' };
      return;
    }
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
    name: body.name,
    provider: body.provider as AiProviderSlug,
    defaultModel: body.defaultModel,
    baseUrl: body.baseUrl,
    config: body.config,
  });

  ctx.status = 201;
  ctx.body = provider;
});

/**
 * @openapi
 * /ai-providers/{aiProviderId}:
 *   patch:
 *     tags:
 *       - AI Providers
 *     summary: Update an AI provider
 *     description: Updates the configuration of an AI provider.
 *     operationId: updateAiProvider
 *     parameters:
 *       - name: aiProviderId
 *         in: path
 *         required: true
 *         description: AI Provider ID
 *         schema:
 *           type: string
 *           example: 'aip_V1StGXR8Z5jdHi6B'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               secretId:
 *                 type: string
 *               name:
 *                 type: string
 *               provider:
 *                 type: string
 *                 enum: [openai, anthropic, google, xai, groq, ollama, azure, bedrock, gateway, custom]
 *               defaultModel:
 *                 type: string
 *               baseUrl:
 *                 type: string
 *               config:
 *                 type: object
 *     responses:
 *       '200':
 *         description: AI provider updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AiProviderRecord'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: AI provider not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
aiProvidersRouter.patch('/ai-providers/:aiProviderId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const existing = await getAiProvider({ id: ctx.params.aiProviderId });
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
    id: ctx.params.aiProviderId,
    secretId: resolvedSecretId,
    name: body.name,
    provider: body.provider as AiProviderSlug | undefined,
    defaultModel: body.defaultModel,
    baseUrl: body.baseUrl,
    config: body.config,
  });

  ctx.body = updated;
});

/**
 * @openapi
 * /ai-providers/{aiProviderId}:
 *   delete:
 *     tags:
 *       - AI Providers
 *     summary: Delete an AI provider
 *     description: Deletes an AI provider.
 *     operationId: deleteAiProvider
 *     parameters:
 *       - name: aiProviderId
 *         in: path
 *         required: true
 *         description: AI Provider ID
 *         schema:
 *           type: string
 *           example: 'aip_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '204':
 *         description: AI provider deleted
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: AI provider not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
aiProvidersRouter.delete(
  '/ai-providers/:aiProviderId',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const existing = await getAiProvider({ id: ctx.params.aiProviderId });
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

    await deleteAiProvider({ id: ctx.params.aiProviderId });
    ctx.status = 204;
  }
);

export { aiProvidersRouter };
