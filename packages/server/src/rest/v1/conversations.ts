import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  addConversationMessage,
  createConversation,
  deleteConversation,
  getConversation,
  getConversationTags,
  listConversationActors,
  listConversationMessages,
  listConversations,
  removeConversationMessage,
  updateConversationStatus,
  updateConversationTags,
} from 'src/lib/conversations';
import { buildSrn } from 'src/lib/iam';

const conversationsRouter = new Router<Context>();

/**
 * @openapi
 * /conversations:
 *   get:
 *     tags:
 *       - Conversations
 *     summary: List conversations
 *     description: Returns all conversations the caller has access to. If projectId is provided, returns only conversations in that project. project keys are scoped to a single project automatically.
 *     operationId: listConversations
 *     parameters:
 *       - name: projectId
 *         in: query
 *         required: false
 *         description: Project ID (optional)
 *         schema:
 *           type: string
 *           example: 'proj_V1StGXR8Z5jdHi6B'
 *       - name: actorId
 *         in: query
 *         required: false
 *         description: Filter by actor ID
 *         schema:
 *           type: string
 *           example: 'act_V1StGXR8Z5jdHi6B'
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
 *         description: List of conversations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ConversationRecord'
 *                 total:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *         required: false
 *         description: Number of results to skip (default 0)
 *         schema:
 *           type: integer
 *           example: 0
 *     responses:
 *       '200':
 *         description: List of conversations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ConversationRecord'
 *                 total:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 offset:
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined;
  const offset = ctx.query.offset ? parseInt(ctx.query.offset as string, 10) : undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'conversations:ListConversations',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listConversations({ projectIds, actorId, limit, offset'
 */
conversationsRouter.get('/conversations', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;
  const actorId = ctx.query.actorId as string | undefined;
  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'conversations:ListConversations',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listConversations({ projectIds, actorId, limit, offset });
});

/**
 * @openapi
 * /conversations/{id}:
 *   get:
 *     tags:
 *       - Conversations
 *     summary: Get a conversation by ID
 *     description: Returns a conversation by its ID
 *     operationId: getConversation
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Conversation ID
 *         schema:
 *           type: string
 *           example: 'conv_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: Conversation found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ConversationRecord'
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
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
conversationsRouter.get('/conversations/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const conversation = await getConversation({ id: ctx.params.id });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return;
  }

  const srnGet = buildSrn({
    projectPublicId: conversation.projectId!,
    resourceType: 'conversation',
    resourceId: conversation.id,
  });
  const contextGet: Record<string, string> = {
    'soat:ResourceType': 'conversation',
  };
  if (conversation.tags) {
    for (const [k, v] of Object.entries(conversation.tags)) {
      contextGet[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: conversation.projectId!,
    action: 'conversations:GetConversation',
    resource: srnGet,
    context: contextGet,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = conversation;
});

/**
 * @openapi
 * /conversations:
 *   post:
 *     tags:
 *       - Conversations
 *     summary: Create a conversation
 *     description: Creates a new conversation. project keys automatically infer the project from the key's scope; JWT callers must supply projectId.
 *     operationId: createConversation
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project ID. Required for JWT auth; omit when using an project key.
 *                 example: 'proj_V1StGXR8Z5jdHi6B'
 *               status:
 *                 type: string
 *                 enum: [open, closed]
 *                 default: open
 *                 description: Initial conversation status
 *     responses:
 *       '201':
 *         description: Conversation created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ConversationRecord'
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
conversationsRouter.post('/conversations', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    status?: string;
  };

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
    action: 'conversations:CreateConversation',
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

  const conversation = await createConversation({
    projectId: project.id,
    status: body.status,
  });

  ctx.status = 201;
  ctx.body = conversation;
});

/**
 * @openapi
 * /conversations/{id}:
 *   patch:
 *     tags:
 *       - Conversations
 *     summary: Update a conversation
 *     description: Updates the status of a conversation
 *     operationId: updateConversation
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Conversation ID
 *         schema:
 *           type: string
 *           example: 'conv_V1StGXR8Z5jdHi6B'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [open, closed]
 *                 description: New conversation status
 *     responses:
 *       '200':
 *         description: Conversation updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ConversationRecord'
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
 *       '404':
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
conversationsRouter.patch('/conversations/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as { status: string };

  if (!body.status) {
    ctx.status = 400;
    ctx.body = { error: 'status is required' };
    return;
  }

  const conversation = await getConversation({ id: ctx.params.id });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return;
  }

  const srnUpd = buildSrn({
    projectPublicId: conversation.projectId!,
    resourceType: 'conversation',
    resourceId: conversation.id,
  });
  const contextUpd: Record<string, string> = {
    'soat:ResourceType': 'conversation',
  };
  if (conversation.tags) {
    for (const [k, v] of Object.entries(conversation.tags)) {
      contextUpd[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: conversation.projectId!,
    action: 'conversations:UpdateConversation',
    resource: srnUpd,
    context: contextUpd,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const updated = await updateConversationStatus({
    id: ctx.params.id,
    status: body.status,
  });

  ctx.body = updated;
});

/**
 * @openapi
 * /conversations/{id}:
 *   delete:
 *     tags:
 *       - Conversations
 *     summary: Delete a conversation
 *     description: Deletes a conversation by its ID
 *     operationId: deleteConversation
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Conversation ID
 *         schema:
 *           type: string
 *           example: 'conv_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '204':
 *         description: Conversation deleted
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
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
conversationsRouter.delete('/conversations/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const conversation = await getConversation({ id: ctx.params.id });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return;
  }

  const srnDel = buildSrn({
    projectPublicId: conversation.projectId!,
    resourceType: 'conversation',
    resourceId: conversation.id,
  });
  const contextDel: Record<string, string> = {
    'soat:ResourceType': 'conversation',
  };
  if (conversation.tags) {
    for (const [k, v] of Object.entries(conversation.tags)) {
      contextDel[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: conversation.projectId!,
    action: 'conversations:DeleteConversation',
    resource: srnDel,
    context: contextDel,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteConversation({ id: ctx.params.id });

  ctx.status = 204;
});

/**
 * @openapi
 * /conversations/{id}/messages:
 *   get:
 *     tags:
 *       - Conversations
 *     summary: List conversation messages
 *     description: Returns all messages (documents) attached to a conversation, ordered by position
 *     operationId: listConversationMessages
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Conversation ID
 *         schema:
 *           type: string
 *           example: 'conv_V1StGXR8Z5jdHi6B'
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
 *         description: List of messages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ConversationMessageRecord'
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
 *       '404':
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
conversationsRouter.get('/conversations/:id/messages', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const conversation = await getConversation({ id: ctx.params.id });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return;
  }

  const srnMsgs = buildSrn({
    projectPublicId: conversation.projectId!,
    resourceType: 'conversation',
    resourceId: conversation.id,
  });
  const contextMsgs: Record<string, string> = {
    'soat:ResourceType': 'conversation',
  };
  if (conversation.tags) {
    for (const [k, v] of Object.entries(conversation.tags)) {
      contextMsgs[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: conversation.projectId!,
    action: 'conversations:GetConversation',
    resource: srnMsgs,
    context: contextMsgs,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;

  const messages = await listConversationMessages({
    conversationId: ctx.params.id,
    limit,
    offset,
  });

  ctx.body = messages;
});

/**
 * @openapi
 * /conversations/{id}/messages:
 *   post:
 *     tags:
 *       - Conversations
 *     summary: Add a message to a conversation
 *     description: Creates a document from the message text and attaches it to the conversation at the given position. If position is omitted, it is appended at the end.
 *     operationId: addConversationMessage
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Conversation ID
 *         schema:
 *           type: string
 *           example: 'conv_V1StGXR8Z5jdHi6B'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *               - actorId
 *             properties:
 *               message:
 *                 type: string
 *                 description: Message text content to add to the conversation
 *                 example: 'Hello, how can I help you?'
 *               actorId:
 *                 type: string
 *                 description: Actor ID who is sending this message
 *                 example: 'act_V1StGXR8Z5jdHi6B'
 *               position:
 *                 type: integer
 *                 description: Zero-based position. Defaults to MAX+1 (append).
 *                 example: 0
 *     responses:
 *       '201':
 *         description: Message added
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ConversationMessageRecord'
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
 *       '404':
 *         description: Conversation or actor not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
conversationsRouter.post(
  '/conversations/:id/messages',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const body = ctx.request.body as {
      message: string;
      actorId: string;
      position?: number;
    };

    if (!body.message) {
      ctx.status = 400;
      ctx.body = { error: 'message is required' };
      return;
    }

    if (!body.actorId) {
      ctx.status = 400;
      ctx.body = { error: 'actorId is required' };
      return;
    }

    const conversation = await getConversation({ id: ctx.params.id });

    if (!conversation) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }

    const srnAddMsg = buildSrn({
      projectPublicId: conversation.projectId!,
      resourceType: 'conversation',
      resourceId: conversation.id,
    });
    const contextAddMsg: Record<string, string> = {
      'soat:ResourceType': 'conversation',
    };
    if (conversation.tags) {
      for (const [k, v] of Object.entries(conversation.tags)) {
        contextAddMsg[`soat:ResourceTag/${k}`] = v as string;
      }
    }
    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: conversation.projectId!,
      action: 'conversations:UpdateConversation',
      resource: srnAddMsg,
      context: contextAddMsg,
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const message = await addConversationMessage({
      conversationId: ctx.params.id,
      message: body.message,
      actorId: body.actorId,
      position: body.position,
    });

    if (!message) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation or actor not found' };
      return;
    }

    ctx.status = 201;
    ctx.body = message;
  }
);

/**
 * @openapi
 * /conversations/{id}/messages/{documentId}:
 *   delete:
 *     tags:
 *       - Conversations
 *     summary: Remove a message from a conversation
 *     description: Removes a document from a conversation
 *     operationId: removeConversationMessage
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Conversation ID
 *         schema:
 *           type: string
 *           example: 'conv_V1StGXR8Z5jdHi6B'
 *       - name: documentId
 *         in: path
 *         required: true
 *         description: Document ID
 *         schema:
 *           type: string
 *           example: 'doc_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '204':
 *         description: Message removed
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
 *         description: Conversation or message not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
conversationsRouter.delete(
  '/conversations/:id/messages/:documentId',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const conversation = await getConversation({ id: ctx.params.id });

    if (!conversation) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }

    const srnRmMsg = buildSrn({
      projectPublicId: conversation.projectId!,
      resourceType: 'conversation',
      resourceId: conversation.id,
    });
    const contextRmMsg: Record<string, string> = {
      'soat:ResourceType': 'conversation',
    };
    if (conversation.tags) {
      for (const [k, v] of Object.entries(conversation.tags)) {
        contextRmMsg[`soat:ResourceTag/${k}`] = v as string;
      }
    }
    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: conversation.projectId!,
      action: 'conversations:UpdateConversation',
      resource: srnRmMsg,
      context: contextRmMsg,
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const result = await removeConversationMessage({
      conversationId: ctx.params.id,
      documentId: ctx.params.documentId,
    });

    if (!result) {
      ctx.status = 404;
      ctx.body = { error: 'Message not found' };
      return;
    }

    ctx.status = 204;
  }
);

/**
 * @openapi
 * /conversations/{id}/actors:
 *   get:
 *     tags:
 *       - Conversations
 *     summary: List actors in a conversation
 *     description: Returns all distinct actors who have sent at least one message in the conversation
 *     operationId: listConversationActors
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Conversation ID
 *         schema:
 *           type: string
 *           example: 'conv_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: List of actors
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ConversationActorRecord'
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
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
conversationsRouter.get('/conversations/:id/actors', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const conversation = await getConversation({ id: ctx.params.id });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return;
  }

  const srnActors = buildSrn({
    projectPublicId: conversation.projectId!,
    resourceType: 'conversation',
    resourceId: conversation.id,
  });
  const contextActors: Record<string, string> = {
    'soat:ResourceType': 'conversation',
  };
  if (conversation.tags) {
    for (const [k, v] of Object.entries(conversation.tags)) {
      contextActors[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: conversation.projectId!,
    action: 'conversations:GetConversation',
    resource: srnActors,
    context: contextActors,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const actors = await listConversationActors({
    conversationId: ctx.params.id,
  });
  ctx.body = actors;
});

/**
 * @openapi
 * /conversations/{id}/tags:
 *   get:
 *     tags:
 *       - Conversations
 *     summary: Get conversation tags
 *     operationId: getConversationTagsRoute
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Conversation tags
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
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
conversationsRouter.get('/conversations/:id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const conversation = await getConversation({ id: ctx.params.id });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return;
  }

  const srn = buildSrn({
    projectPublicId: conversation.projectId!,
    resourceType: 'conversation',
    resourceId: conversation.id,
  });
  const context: Record<string, string> = {
    'soat:ResourceType': 'conversation',
  };
  if (conversation.tags) {
    for (const [k, v] of Object.entries(conversation.tags)) {
      context[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: conversation.projectId!,
    action: 'conversations:GetConversation',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await getConversationTags({ id: ctx.params.id });
});

/**
 * @openapi
 * /conversations/{id}/tags:
 *   put:
 *     tags:
 *       - Conversations
 *     summary: Replace conversation tags
 *     operationId: putConversationTags
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
 *               $ref: '#/components/schemas/ConversationRecord'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
conversationsRouter.put('/conversations/:id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const conversation = await getConversation({ id: ctx.params.id });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return;
  }

  const srn = buildSrn({
    projectPublicId: conversation.projectId!,
    resourceType: 'conversation',
    resourceId: conversation.id,
  });
  const context: Record<string, string> = {
    'soat:ResourceType': 'conversation',
  };
  if (conversation.tags) {
    for (const [k, v] of Object.entries(conversation.tags)) {
      context[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: conversation.projectId!,
    action: 'conversations:UpdateConversation',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateConversationTags({
    id: ctx.params.id,
    tags,
    merge: false,
  });
});

/**
 * @openapi
 * /conversations/{id}/tags:
 *   patch:
 *     tags:
 *       - Conversations
 *     summary: Merge conversation tags
 *     operationId: patchConversationTags
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
 *               $ref: '#/components/schemas/ConversationRecord'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
conversationsRouter.patch('/conversations/:id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const conversation = await getConversation({ id: ctx.params.id });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return;
  }

  const srn = buildSrn({
    projectPublicId: conversation.projectId!,
    resourceType: 'conversation',
    resourceId: conversation.id,
  });
  const context: Record<string, string> = {
    'soat:ResourceType': 'conversation',
  };
  if (conversation.tags) {
    for (const [k, v] of Object.entries(conversation.tags)) {
      context[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: conversation.projectId!,
    action: 'conversations:UpdateConversation',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateConversationTags({
    id: ctx.params.id,
    tags,
    merge: true,
  });
});

export { conversationsRouter };
