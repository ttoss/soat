import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createActor,
  deleteActor,
  getActor,
  listActors,
  updateActor,
} from 'src/lib/actors';

const actorsRouter = new Router<Context>();

/**
 * @openapi
 * /actors:
 *   get:
 *     tags:
 *       - Actors
 *     summary: List actors
 *     description: Returns all actors the caller has access to. If projectId is provided, returns only actors in that project. API keys are scoped to a single project automatically. JWT users without projectId receive actors across all their accessible projects.
 *     operationId: listActors
 *     parameters:
 *       - name: projectId
 *         in: query
 *         required: false
 *         description: Project public ID (optional)
 *         schema:
 *           type: string
 *           example: 'proj_V1StGXR8Z5jdHi6B'
 *       - name: externalId
 *         in: query
 *         required: false
 *         description: External ID to filter by (e.g. WhatsApp phone number)
 *         schema:
 *           type: string
 *           example: '+15551234567'
 *     responses:
 *       '200':
 *         description: List of actors
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ActorRecord'
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
actorsRouter.get('/actors', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;
  const externalId = ctx.query.externalId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'actors:ListActors',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listActors({ projectIds, externalId });
});

/**
 * @openapi
 * /actors/{id}:
 *   get:
 *     tags:
 *       - Actors
 *     summary: Get an actor by ID
 *     description: Returns an actor by its public ID
 *     operationId: getActor
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Actor ID
 *         schema:
 *           type: string
 *           example: 'act_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: Actor found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ActorRecord'
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
 *         description: Actor not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
actorsRouter.get('/actors/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const actor = await getActor({ id: ctx.params.id });

  if (!actor) {
    ctx.status = 404;
    ctx.body = { error: 'Actor not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed(
    actor.projectId!,
    'actors:GetActor'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = actor;
});

/**
 * @openapi
 * /actors:
 *   post:
 *     tags:
 *       - Actors
 *     summary: Create an actor
 *     description: Creates a new actor. API keys automatically infer the project from the key's scope; JWT callers must supply projectId.
 *     operationId: createActor
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
 *                 description: Project public ID. Required for JWT auth; omit when using an API key.
 *                 example: 'proj_V1StGXR8Z5jdHi6B'
 *               name:
 *                 type: string
 *                 example: 'Alice'
 *               type:
 *                 type: string
 *                 description: Optional actor type (e.g. 'customer', 'agent')
 *                 example: 'customer'
 *               externalId:
 *                 type: string
 *                 description: Optional external identifier (e.g. WhatsApp phone number). Must be unique within a project.
 *                 example: '+15551234567'
 *     responses:
 *       '201':
 *         description: Actor created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ActorRecord'
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
actorsRouter.post('/actors', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    name: string;
    type?: string;
    externalId?: string;
  };

  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  let resolvedProjectPublicId = body.projectId;
  if (!resolvedProjectPublicId) {
    if (ctx.authUser.apiKeyProjectId) {
      resolvedProjectPublicId = ctx.authUser.apiKeyProjectId;
    } else {
      ctx.status = 400;
      ctx.body = { error: 'projectId is required' };
      return;
    }
  }

  const allowed = await ctx.authUser.isAllowed(
    resolvedProjectPublicId,
    'actors:CreateActor'
  );
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

  try {
    const actor = await createActor({
      projectId: project.id,
      name: body.name,
      type: body.type,
      externalId: body.externalId,
    });

    ctx.status = 201;
    ctx.body = actor;
  } catch (error) {
    if (
      (error as { name?: string }).name === 'SequelizeUniqueConstraintError'
    ) {
      ctx.status = 409;
      ctx.body = {
        error: 'An actor with this externalId already exists in the project',
      };
      return;
    }
    throw error;
  }
});

/**
 * @openapi
 * /actors/{id}:
 *   delete:
 *     tags:
 *       - Actors
 *     summary: Delete an actor
 *     description: Deletes an actor by its public ID
 *     operationId: deleteActor
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Actor ID
 *         schema:
 *           type: string
 *           example: 'act_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '204':
 *         description: Actor deleted
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
 *         description: Actor not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
actorsRouter.delete('/actors/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const actor = await getActor({ id: ctx.params.id });

  if (!actor) {
    ctx.status = 404;
    ctx.body = { error: 'Actor not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed(
    actor.projectId!,
    'actors:DeleteActor'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteActor({ id: ctx.params.id });
  ctx.status = 204;
});

/**
 * @openapi
 * /actors/{id}:
 *   patch:
 *     tags:
 *       - Actors
 *     summary: Update an actor
 *     description: Updates an actor's name, type, or externalId
 *     operationId: updateActor
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Actor ID
 *         schema:
 *           type: string
 *           example: 'act_V1StGXR8Z5jdHi6B'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: 'Updated Actor'
 *               type:
 *                 type: string
 *                 example: 'assistant'
 *               externalId:
 *                 type: string
 *                 example: '+15551234567'
 *     responses:
 *       '200':
 *         description: Actor updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ActorRecord'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         description: Actor not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
actorsRouter.patch('/actors/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const actor = await getActor({ id: ctx.params.id });

  if (!actor) {
    ctx.status = 404;
    ctx.body = { error: 'Actor not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed(
    actor.projectId!,
    'actors:UpdateActor'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    name?: string;
    type?: string;
    externalId?: string;
  };

  const updated = await updateActor({
    id: ctx.params.id,
    name: body.name,
    type: body.type,
    externalId: body.externalId,
  });

  ctx.body = updated;
});

export { actorsRouter };
