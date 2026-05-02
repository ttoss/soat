import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { generateConversationMessage } from 'src/lib/conversationGeneration';
import {
  addConversationMessage,
  removeConversationMessage,
} from 'src/lib/conversationMessages';
import {
  getConversation,
  getConversationTags,
  listConversationActors,
  listConversationMessages,
  updateConversationTags,
} from 'src/lib/conversations';

import { checkConversationAccess } from './conversationHelpers';

type GenerateResult = Awaited<ReturnType<typeof generateConversationMessage>>;

const handleGenerateResult = (
  ctx: Context,
  result: GenerateResult
): boolean => {
  if (result === 'conversation_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return false;
  }
  if (result === 'agent_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found in this project' };
    return false;
  }
  if (result === 'ai_provider_not_found') {
    ctx.status = 400;
    ctx.body = { error: 'AI provider not found or not configured' };
    return false;
  }
  if (result === 'agent_or_chat_not_found') {
    ctx.status = 400;
    ctx.body = { error: "The actor's linked agent or chat could not be found" };
    return false;
  }
  return true;
};

const conversationSubResourcesRouter = new Router<Context>();

conversationSubResourcesRouter.get(
  '/conversations/:conversation_id/messages',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:GetConversation'
      ))
    ) {
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
      conversationId: ctx.params.conversation_id,
      limit,
      offset,
    });

    ctx.body = messages;
  }
);

conversationSubResourcesRouter.post(
  '/conversations/:conversation_id/messages',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const body = ctx.request.body as {
      message: string;
      role: string;
      actorId?: string | null;
      position?: number;
      metadata?: Record<string, unknown>;
    };

    if (!body.message) {
      ctx.status = 400;
      ctx.body = { error: 'message is required' };
      return;
    }

    if (!body.role) {
      ctx.status = 400;
      ctx.body = { error: 'role is required' };
      return;
    }

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:UpdateConversation'
      ))
    ) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const message = await addConversationMessage({
      conversationId: ctx.params.conversation_id,
      message: body.message,
      role: body.role,
      actorId: body.actorId ?? null,
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

conversationSubResourcesRouter.delete(
  '/conversations/:conversation_id/messages/:document_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:UpdateConversation'
      ))
    ) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const result = await removeConversationMessage({
      conversationId: ctx.params.conversation_id,
      documentId: ctx.params.document_id,
    });

    if (!result) {
      ctx.status = 404;
      ctx.body = { error: 'Message not found' };
      return;
    }

    ctx.status = 204;
  }
);

conversationSubResourcesRouter.get(
  '/conversations/:conversation_id/actors',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:GetConversation'
      ))
    ) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const actors = await listConversationActors({
      conversationId: ctx.params.conversation_id,
    });
    ctx.body = actors;
  }
);

conversationSubResourcesRouter.get(
  '/conversations/:conversation_id/tags',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:GetConversation'
      ))
    ) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    ctx.body = await getConversationTags({ id: ctx.params.conversation_id });
  }
);

conversationSubResourcesRouter.put(
  '/conversations/:conversation_id/tags',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:UpdateConversation'
      ))
    ) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const tags = ctx.request.body as Record<string, string>;
    ctx.body = await updateConversationTags({
      id: ctx.params.conversation_id,
      tags,
      merge: false,
    });
  }
);

conversationSubResourcesRouter.patch(
  '/conversations/:conversation_id/tags',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:UpdateConversation'
      ))
    ) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const tags = ctx.request.body as Record<string, string>;
    ctx.body = await updateConversationTags({
      id: ctx.params.conversation_id,
      tags,
      merge: true,
    });
  }
);

conversationSubResourcesRouter.post(
  '/conversations/:conversation_id/generate',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const body = ctx.request.body as {
      agentId: string;
      model?: string;
      stream?: boolean;
      toolContext?: Record<string, string>;
    };

    if (!body.agentId) {
      ctx.status = 400;
      ctx.body = { error: 'agentId is required' };
      return;
    }

    if (body.stream) {
      ctx.status = 501;
      ctx.body = {
        error: 'Streaming is not implemented in v1. Omit stream or set false.',
      };
      return;
    }

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });
    if (!conversation) {
      ctx.status = 404;
      ctx.body = { error: 'Conversation not found' };
      return;
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:GenerateConversationMessage'
      ))
    ) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const result = await generateConversationMessage({
      conversationId: ctx.params.conversation_id,
      agentId: body.agentId,
      model: body.model,
      toolContext: body.toolContext,
    });

    if (!handleGenerateResult(ctx, result)) {
      return;
    }

    ctx.status = 200;
    ctx.body = result;
  }
);

export { conversationSubResourcesRouter };
