import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  addConversationMessage,
  createConversation,
  deleteConversation,
  generateConversationMessage,
  getConversation,
  getConversationTags,
  listConversationActors,
  listConversationMessages,
  listConversations,
  removeConversationMessage,
  updateConversation,
  updateConversationTags,
} from 'src/lib/conversations';
import { buildSrn } from 'src/lib/iam';

const conversationsRouter = new Router<Context>();

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

  const conversations = await listConversations({
    projectIds,
    actorId,
    limit,
    offset,
  });

  const filteredData = (
    await Promise.all(
      conversations.data.map(async (conversation) => {
        if (!conversation.projectId) return null;
        const srn = buildSrn({
          projectPublicId: conversation.projectId,
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
        const allowed = await ctx.authUser!.isAllowed({
          projectPublicId: conversation.projectId,
          action: 'conversations:ListConversations',
          resource: srn,
          context,
        });
        return allowed ? conversation : null;
      })
    )
  ).filter((conversation): conversation is NonNullable<typeof conversation> => {
    return conversation !== null;
  });

  ctx.body = {
    data: filteredData,
    total: filteredData.length,
    limit: conversations.limit,
    offset: conversations.offset,
  };
});

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

conversationsRouter.post('/conversations', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    status?: string;
    name?: string | null;
    actorId?: string | null;
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

  let resolvedActorId: number | null = null;
  if (body.actorId) {
    const actor = await db.Actor.findOne({
      where: { publicId: body.actorId },
    });
    if (!actor) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid actor ID' };
      return;
    }
    resolvedActorId = actor.id;
  }

  const conversation = await createConversation({
    projectId: project.id,
    status: body.status,
    name: body.name ?? null,
    actorId: resolvedActorId,
  });

  ctx.status = 201;
  ctx.body = conversation;
});

conversationsRouter.patch('/conversations/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as { status?: string; name?: string | null };

  if (body.status === undefined && body.name === undefined) {
    ctx.status = 400;
    ctx.body = { error: 'At least one of status or name is required' };
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

  const updated = await updateConversation({
    id: ctx.params.id,
    status: body.status,
    name: body.name,
  });

  ctx.body = updated;
});

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
      metadata?: Record<string, unknown>;
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
      metadata: body.metadata,
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

conversationsRouter.post(
  '/conversations/:id/generate',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const body = ctx.request.body as {
      actorId: string;
      model?: string;
      stream?: boolean;
      toolContext?: Record<string, string>;
    };

    if (!body.actorId) {
      ctx.status = 400;
      ctx.body = { error: 'actorId is required' };
      return;
    }

    if (body.stream) {
      ctx.status = 501;
      ctx.body = {
        error: 'Streaming is not implemented in v1. Omit stream or set false.',
      };
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
    const contextGen: Record<string, string> = {
      'soat:ResourceType': 'conversation',
    };
    if (conversation.tags) {
      for (const [k, v] of Object.entries(conversation.tags)) {
        contextGen[`soat:ResourceTag/${k}`] = v as string;
      }
    }
    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: conversation.projectId!,
      action: 'conversations:GenerateConversationMessage',
      resource: srn,
      context: contextGen,
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const result = await generateConversationMessage({
      conversationId: ctx.params.id,
      actorId: body.actorId,
      model: body.model,
      toolContext: body.toolContext,
    });

    if (result === 'conversation_not_found') {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }
    if (result === 'actor_not_found') {
      ctx.status = 404;
      ctx.body = { error: 'Actor not found in this project' };
      return;
    }
    if (result === 'actor_missing_agent_or_chat') {
      ctx.status = 400;
      ctx.body = {
        error:
          'The generating actor must have either agentId or chatId set to produce messages.',
      };
      return;
    }
    if (result === 'ai_provider_not_found') {
      ctx.status = 400;
      ctx.body = { error: 'AI provider not found or not configured' };
      return;
    }
    if (result === 'agent_or_chat_not_found') {
      ctx.status = 400;
      ctx.body = {
        error: "The actor's linked agent or chat could not be found",
      };
      return;
    }

    ctx.status = 200;
    ctx.body = result;
  }
);

export { conversationsRouter };
