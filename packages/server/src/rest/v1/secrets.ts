import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createSecret,
  deleteSecret,
  getSecret,
  listSecrets,
  updateSecret,
} from 'src/lib/secrets';

const secretsRouter = new Router<Context>();

/**
 * @openapi
 * /secrets:
 *   get:
 *     tags:
 *       - Secrets
 *     summary: List secrets
 *     description: Returns all secrets in the project. Values are never returned.
 *     operationId: listSecrets
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
 *         description: List of secrets
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/SecretRecord'
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
secretsRouter.get('/secrets', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'secrets:ListSecrets',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listSecrets({ projectIds: projectIds ?? [] });
});

/**
 * @openapi
 * /secrets/{secretId}:
 *   get:
 *     tags:
 *       - Secrets
 *     summary: Get a secret by ID
 *     description: Returns secret metadata. The value is never returned.
 *     operationId: getSecret
 *     parameters:
 *       - name: secretId
 *         in: path
 *         required: true
 *         description: Secret ID
 *         schema:
 *           type: string
 *           example: 'sec_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: Secret found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SecretRecord'
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
 *         description: Secret not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
secretsRouter.get('/secrets/:secretId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const secret = await getSecret({ id: ctx.params.secretId });

  if (!secret) {
    ctx.status = 404;
    ctx.body = { error: 'Secret not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: secret.projectId!,
    action: 'secrets:GetSecret',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = secret;
});

/**
 * @openapi
 * /secrets:
 *   post:
 *     tags:
 *       - Secrets
 *     summary: Create a secret
 *     description: Creates a new secret. The value is encrypted at rest and never returned.
 *     operationId: createSecret
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project ID. Required for JWT auth; omit when using a project key.
 *                 example: 'proj_V1StGXR8Z5jdHi6B'
 *               name:
 *                 type: string
 *                 example: 'OpenAI Production Key'
 *               value:
 *                 type: string
 *                 description: The secret value to encrypt and store
 *                 example: 'sk-...'
 *     responses:
 *       '201':
 *         description: Secret created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SecretRecord'
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
secretsRouter.post('/secrets', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    name?: string;
    value?: string;
  };

  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
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
    action: 'secrets:CreateSecret',
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

  const secret = await createSecret({
    projectId: project.id,
    name: body.name,
    value: body.value,
  });

  ctx.status = 201;
  ctx.body = secret;
});

/**
 * @openapi
 * /secrets/{secretId}:
 *   patch:
 *     tags:
 *       - Secrets
 *     summary: Update a secret
 *     description: Updates the name or value of a secret.
 *     operationId: updateSecret
 *     parameters:
 *       - name: secretId
 *         in: path
 *         required: true
 *         description: Secret ID
 *         schema:
 *           type: string
 *           example: 'sec_V1StGXR8Z5jdHi6B'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               value:
 *                 type: string
 *                 description: New secret value to encrypt and store
 *     responses:
 *       '200':
 *         description: Secret updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SecretRecord'
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
 *         description: Secret not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
secretsRouter.patch('/secrets/:secretId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const secret = await getSecret({ id: ctx.params.secretId });
  if (!secret) {
    ctx.status = 404;
    ctx.body = { error: 'Secret not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: secret.projectId!,
    action: 'secrets:UpdateSecret',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as { name?: string; value?: string };

  const updated = await updateSecret({
    id: ctx.params.secretId,
    name: body.name,
    value: body.value,
  });

  ctx.body = updated;
});

/**
 * @openapi
 * /secrets/{secretId}:
 *   delete:
 *     tags:
 *       - Secrets
 *     summary: Delete a secret
 *     description: Deletes a secret. Returns 409 if referenced by an AI provider unless force=true.
 *     operationId: deleteSecret
 *     parameters:
 *       - name: secretId
 *         in: path
 *         required: true
 *         description: Secret ID
 *         schema:
 *           type: string
 *           example: 'sec_V1StGXR8Z5jdHi6B'
 *       - name: force
 *         in: query
 *         required: false
 *         description: If true, also delete dependent AI providers
 *         schema:
 *           type: boolean
 *     responses:
 *       '204':
 *         description: Secret deleted
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
 *         description: Secret not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '409':
 *         description: Conflict — secret is referenced by one or more AI providers
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
secretsRouter.delete('/secrets/:secretId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const secret = await getSecret({ id: ctx.params.secretId });
  if (!secret) {
    ctx.status = 404;
    ctx.body = { error: 'Secret not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: secret.projectId!,
    action: 'secrets:DeleteSecret',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const force = ctx.query.force === 'true';
  const result = await deleteSecret({ id: ctx.params.secretId, force });

  if (result === 'conflict') {
    ctx.status = 409;
    ctx.body = {
      error:
        'Secret is referenced by one or more AI providers. Use force=true to delete them as well.',
    };
    return;
  }

  ctx.status = 204;
});

export { secretsRouter };
