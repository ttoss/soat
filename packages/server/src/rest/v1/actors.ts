import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createActor,
  deleteActor,
  getActor,
  getActorTags,
  listActors,
  updateActor,
  updateActorTags,
} from 'src/lib/actors';
import { buildSrn } from 'src/lib/iam';

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
 *         description: Project ID (optional)
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
 *       - name: name
 *         in: query
 *         required: false
 *         description: Partial, case-insensitive name filter
 *         schema:
 *           type: string
 *           example: 'alice'
 *       - name: type
 *         in: query
 *         required: false
 *         description: Exact type filter (e.g. customer, agent)
 *         schema:
 *           type: string
 *           example: 'customer'
 *       - name: limit
 *         in: query
 *         required: false
 *         description: Maximum number of results to return (default 50)
 *         schema:
 *           type: integer
 *           example: 50
 *       - name: offset
 *         in: query
 *         required: false
 *         description: Number of results to skip (default 0)
 *         schema:
 *           type: integer
 *           example: 0
 *     responses:
 *       '200':
 *         description: List of actors
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ActorRecord'
 *                 total:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 offset:
 *                   type: integer
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
  const name = ctx.query.name as string | undefined;
  const type = ctx.query.type as string | undefined;
  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'actors:ListActors',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listActors({
    projectIds,
    externalId,
    name,
    type,
    limit,
    offset,
  });
});

/**
 * @openapi
 * /actors/{id}:
 *   get:
 *     tags:
 *       - Actors
 *     summary: Get an actor by ID
 *     description: Returns an actor by its ID
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

  const srnGet = buildSrn({
    projectPublicId: actor.projectId!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const contextGet: Record<string, string> = { 'soat:ResourceType': 'actor' };
  if (actor.tags) {
    for (const [k, v] of Object.entries(actor.tags)) {
      contextGet[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.projectId!,
    action: 'actors:GetActor',
    resource: srnGet,
    context: contextGet,
  });
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
 *                 description: Project ID. Required for JWT auth; omit when using an API key.
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
 *               instructions:
 *                 type: string
 *                 nullable: true
 *                 description: Persona-specific instructions composed into the effective system prompt for generate calls.
 *               agentId:
 *                 type: string
 *                 description: Optional Agent ID to link this actor to. Mutually exclusive with chatId.
 *               chatId:
 *                 type: string
 *                 description: Optional Chat ID to link this actor to. Mutually exclusive with agentId.
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
    instructions?: string | null;
    agentId?: string;
    chatId?: string;
  };

  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  if (body.agentId && body.chatId) {
    ctx.status = 400;
    ctx.body = {
      error: 'agentId and chatId are mutually exclusive',
    };
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
    action: 'actors:CreateActor',
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

  try {
    let agentDbId: number | null | undefined;
    if (body.agentId !== undefined) {
      const agent = await db.Agent.findOne({
        where: { publicId: body.agentId, projectId: project.id as number },
      });
      if (!agent) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid agentId' };
        return;
      }
      agentDbId = agent.id as number;
    }

    let chatDbId: number | null | undefined;
    if (body.chatId !== undefined) {
      const chat = await db.Chat.findOne({
        where: { publicId: body.chatId, projectId: project.id as number },
      });
      if (!chat) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid chatId' };
        return;
      }
      chatDbId = chat.id as number;
    }

    const actor = await createActor({
      projectId: project.id,
      name: body.name,
      type: body.type,
      externalId: body.externalId,
      instructions: body.instructions ?? null,
      agentId: agentDbId,
      chatId: chatDbId,
    });

    if (actor === 'agent_and_chat_exclusive') {
      ctx.status = 400;
      ctx.body = { error: 'agentId and chatId are mutually exclusive' };
      return;
    }

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
 *     description: Deletes an actor by its ID
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

  const srnDel = buildSrn({
    projectPublicId: actor.projectId!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const contextDel: Record<string, string> = { 'soat:ResourceType': 'actor' };
  if (actor.tags) {
    for (const [k, v] of Object.entries(actor.tags)) {
      contextDel[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.projectId!,
    action: 'actors:DeleteActor',
    resource: srnDel,
    context: contextDel,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await deleteActor({ id: ctx.params.id });
  if (result === 'has_messages') {
    ctx.status = 409;
    ctx.body = {
      error:
        'Actor is referenced by conversation messages. Remove those messages or delete the containing conversations first.',
    };
    return;
  }
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
 *               instructions:
 *                 type: string
 *                 nullable: true
 *                 description: Persona-specific instructions. Pass null to clear.
 *               agentId:
 *                 type: string
 *                 nullable: true
 *                 description: Agent to link to this actor. Pass null to unlink.
 *               chatId:
 *                 type: string
 *                 nullable: true
 *                 description: Chat to link to this actor. Pass null to unlink.
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

  const srnUpd = buildSrn({
    projectPublicId: actor.projectId!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const contextUpd: Record<string, string> = { 'soat:ResourceType': 'actor' };
  if (actor.tags) {
    for (const [k, v] of Object.entries(actor.tags)) {
      contextUpd[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.projectId!,
    action: 'actors:UpdateActor',
    resource: srnUpd,
    context: contextUpd,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    name?: string;
    type?: string;
    externalId?: string;
    instructions?: string | null;
    agentId?: string | null;
    chatId?: string | null;
  };

  const updated = await updateActor({
    id: ctx.params.id,
    name: body.name,
    type: body.type,
    externalId: body.externalId,
    instructions: body.instructions,
    agentId: body.agentId,
    chatId: body.chatId,
  });

  if (updated === 'agent_not_found') {
    ctx.status = 400;
    ctx.body = { error: 'Invalid agentId' };
    return;
  }
  if (updated === 'chat_not_found') {
    ctx.status = 400;
    ctx.body = { error: 'Invalid chatId' };
    return;
  }
  if (updated === 'agent_and_chat_exclusive') {
    ctx.status = 400;
    ctx.body = { error: 'agentId and chatId are mutually exclusive' };
    return;
  }

  ctx.body = updated;
});

/**
 * @openapi
 * /actors/{id}/tags:
 *   get:
 *     tags:
 *       - Actors
 *     summary: Get actor tags
 *     operationId: getActorTagsRoute
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Actor tags
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: string
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
actorsRouter.get('/actors/:id/tags', async (ctx: Context) => {
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

  const srn = buildSrn({
    projectPublicId: actor.projectId!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const context: Record<string, string> = { 'soat:ResourceType': 'actor' };
  if (actor.tags) {
    for (const [k, v] of Object.entries(actor.tags)) {
      context[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.projectId!,
    action: 'actors:GetActor',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await getActorTags({ id: ctx.params.id });
});

/**
 * @openapi
 * /actors/{id}/tags:
 *   put:
 *     tags:
 *       - Actors
 *     summary: Replace actor tags
 *     operationId: putActorTags
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties:
 *               type: string
 *     responses:
 *       '200':
 *         description: Tags replaced
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
actorsRouter.put('/actors/:id/tags', async (ctx: Context) => {
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

  const srn = buildSrn({
    projectPublicId: actor.projectId!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const context: Record<string, string> = { 'soat:ResourceType': 'actor' };
  if (actor.tags) {
    for (const [k, v] of Object.entries(actor.tags)) {
      context[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.projectId!,
    action: 'actors:UpdateActor',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateActorTags({ id: ctx.params.id, tags, merge: false });
});

/**
 * @openapi
 * /actors/{id}/tags:
 *   patch:
 *     tags:
 *       - Actors
 *     summary: Merge actor tags
 *     operationId: patchActorTags
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties:
 *               type: string
 *     responses:
 *       '200':
 *         description: Tags merged
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
actorsRouter.patch('/actors/:id/tags', async (ctx: Context) => {
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

  const srn = buildSrn({
    projectPublicId: actor.projectId!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const context: Record<string, string> = { 'soat:ResourceType': 'actor' };
  if (actor.tags) {
    for (const [k, v] of Object.entries(actor.tags)) {
      context[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.projectId!,
    action: 'actors:UpdateActor',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateActorTags({ id: ctx.params.id, tags, merge: true });
});

export { actorsRouter };
