import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { createApiKey, getApiKey, updateApiKey } from 'src/lib/apiKeys';

const apiKeysRouter = new Router<Context>();

/**
 * @openapi
 * /api-keys:
 *   post:
 *     tags:
 *       - API Keys
 *     summary: Create a new API key
 *     description: Creates a new API key for a user in a project with specified policy
 *     operationId: createApiKey
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *               - policyId
 *               - name
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project public ID
 *               policyId:
 *                 type: string
 *                 description: Policy public ID
 *               name:
 *                 type: string
 *                 description: API key name
 *     responses:
 *       '201':
 *         description: API key created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 key:
 *                   type: string
 *                   description: The full API key (shown only once)
 *                 keyPrefix:
 *                   type: string
 *                 createdAt:
 *                   type: string
 *                 updatedAt:
 *                   type: string
 *       '400':
 *         description: Bad request
 *       '403':
 *         description: Forbidden
 *       '500':
 *         description: Internal server error
 */
apiKeysRouter.post('/api-keys', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { projectId, policyId, name } = ctx.request.body as {
    projectId: string;
    policyId: string;
    name: string;
  };

  if (!projectId || !policyId || !name) {
    ctx.status = 400;
    ctx.body = { error: 'Missing required fields' };
    return;
  }

  // Find the project
  const project = await db.Project.findOne({
    where: { publicId: projectId },
  });

  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project' };
    return;
  }

  // Check if user is member of the project
  const membership = await db.UserProject.findOne({
    where: {
      userId: ctx.authUser.id,
      projectId: project.id,
    },
  });

  if (!membership) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  // Check if policy exists and belongs to the project
  const policy = await db.ProjectPolicy.findOne({
    where: {
      publicId: policyId,
      projectId: project.id,
    },
  });

  if (!policy) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid policy' };
    return;
  }

  const apiKey = await createApiKey({
    userId: ctx.authUser.id,
    projectId: project.id,
    policyId: policy.id,
    name,
  });

  ctx.status = 201;
  ctx.body = apiKey;
});

/**
 * @openapi
 * /api-keys/{id}:
 *   get:
 *     tags:
 *       - API Keys
 *     summary: Get an API key by ID
 *     description: Returns the data and metadata of a specific API key
 *     operationId: getApiKey
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: API key ID
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: API key found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 keyPrefix:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 projectId:
 *                   type: string
 *                 policyId:
 *                   type: string
 *                 createdAt:
 *                   type: string
 *                 updatedAt:
 *                   type: string
 *       '404':
 *         description: API key not found
 *       '403':
 *         description: Forbidden
 *       '500':
 *         description: Internal server error
 */
apiKeysRouter.get('/api-keys/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const apiKey = await getApiKey({ id: ctx.params.id });

  if (!apiKey) {
    ctx.status = 404;
    ctx.body = { error: 'API key not found' };
    return;
  }

  // Check if user owns the API key
  if (apiKey.userId !== ctx.authUser.publicId) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = apiKey;
});

/**
 * @openapi
 * /api-keys/{id}:
 *   put:
 *     tags:
 *       - API Keys
 *     summary: Update an API key
 *     description: Updates the policy of a specific API key
 *     operationId: updateApiKey
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: API key ID
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - policyId
 *             properties:
 *               policyId:
 *                 type: string
 *                 description: New policy public ID
 *     responses:
 *       '200':
 *         description: API key updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 keyPrefix:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 projectId:
 *                   type: string
 *                 policyId:
 *                   type: string
 *                 createdAt:
 *                   type: string
 *                 updatedAt:
 *                   type: string
 *       '404':
 *         description: API key not found
 *       '403':
 *         description: Forbidden
 *       '500':
 *         description: Internal server error
 */
apiKeysRouter.put('/api-keys/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { policyId } = ctx.request.body as {
    policyId: string;
  };

  if (!policyId) {
    ctx.status = 400;
    ctx.body = { error: 'Missing policyId' };
    return;
  }

  // Find the policy
  const policy = await db.ProjectPolicy.findOne({
    where: { publicId: policyId },
  });

  if (!policy) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid policy' };
    return;
  }

  // Check if user owns the API key
  const apiKeyRecord = await db.ApiKey.findOne({
    where: { publicId: ctx.params.id },
    include: [{ model: db.User }, { model: db.Project }],
  });

  if (!apiKeyRecord) {
    ctx.status = 404;
    ctx.body = { error: 'API key not found' };
    return;
  }

  if (apiKeyRecord.userId !== ctx.authUser.id) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  // Check if policy belongs to the same project as the API key
  if (policy.projectId !== apiKeyRecord.projectId) {
    ctx.status = 400;
    ctx.body = { error: 'Policy does not belong to the same project' };
    return;
  }

  const updatedApiKey = await updateApiKey({
    id: ctx.params.id,
    policyId: policy.id,
  });

  ctx.body = updatedApiKey;
});

export { apiKeysRouter };
