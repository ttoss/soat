import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { mapGenerationRequiredAction } from 'src/lib/agentGenerationHelpers';
import {
  generateConversationMessage,
  resolveConversationAndAgent,
} from 'src/lib/conversationGeneration';
import {
  addConversationMessage,
  removeConversationMessage,
} from 'src/lib/conversationMessages';
import {
  getConversation,
  getConversationTags,
  listConversationMessages,
  updateConversationTags,
} from 'src/lib/conversations';

import { checkConversationAccess } from './conversationHelpers';
import { requireAuth } from './helpers';
import { assertNotSystemRole } from './systemMessageGuard';

const conversationSubResourcesRouter = new Router<Context>();

conversationSubResourcesRouter.get(
  '/conversations/:conversation_id/messages',
  async (ctx: Context) => {
    requireAuth(ctx);

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:GetConversation'
      ))
    ) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
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
    requireAuth(ctx);

    const body = ctx.request.body as {
      message: string;
      role: string;
      actor_id?: string | null;
      position?: number;
      metadata?: Record<string, unknown>;
    };

    assertNotSystemRole({
      role: body.role,
      remedy:
        'Conversation history carries only `user` and `assistant` turns; system content belongs to the generating agent (its `instructions` field) or the actor persona.',
    });

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found.');
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:UpdateConversation'
      ))
    ) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    const message = await addConversationMessage({
      conversationId: ctx.params.conversation_id,
      message: body.message,
      role: body.role,
      actorId: body.actor_id ?? null,
      position: body.position,
      metadata: body.metadata,
    });

    if (!message) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        'Conversation or actor not found.'
      );
    }

    ctx.status = 201;
    ctx.body = message;
  }
);

conversationSubResourcesRouter.delete(
  '/conversations/:conversation_id/messages/:document_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found.');
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:UpdateConversation'
      ))
    ) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    const result = await removeConversationMessage({
      conversationId: ctx.params.conversation_id,
      documentId: ctx.params.document_id,
    });

    if (!result) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Message not found.');
    }

    ctx.status = 204;
  }
);

conversationSubResourcesRouter.get(
  '/conversations/:conversation_id/tags',
  async (ctx: Context) => {
    requireAuth(ctx);

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:GetConversation'
      ))
    ) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    ctx.body = await getConversationTags({ id: ctx.params.conversation_id });
  }
);

conversationSubResourcesRouter.put(
  '/conversations/:conversation_id/tags',
  async (ctx: Context) => {
    requireAuth(ctx);

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:UpdateConversation'
      ))
    ) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
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
    requireAuth(ctx);

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:UpdateConversation'
      ))
    ) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
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
    requireAuth(ctx);

    const body = ctx.request.body as {
      agent_id: string;
      model?: string;
      stream?: boolean;
      tool_context?: Record<string, string>;
    };

    if (body.stream) {
      throw new DomainError(
        'NOT_IMPLEMENTED',
        'Streaming is not implemented in v1. Omit stream or set false.'
      );
    }

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });
    if (!conversation) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
    }

    if (
      !(await checkConversationAccess(
        ctx.authUser!,
        conversation,
        'conversations:GenerateConversationMessage'
      ))
    ) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    // The agent is resolved first either way, so an unknown one is still a
    // synchronous 404 rather than a failure the caller can only discover by
    // polling.
    if (ctx.query['wait'] !== 'true') {
      await resolveConversationAndAgent({
        conversationId: ctx.params.conversation_id,
        agentId: body.agent_id,
      });

      generateConversationMessage({
        conversationId: ctx.params.conversation_id,
        agentId: body.agent_id,
        model: body.model,
        toolContext: body.tool_context,
      }).catch(() => {
        // Fire-and-forget: the reply lands as a conversation message, and
        // failures surface on the generation record the caller polls.
      });

      ctx.status = 202;
      ctx.body = {
        status: 'accepted',
        conversation_id: ctx.params.conversation_id,
      };
      return;
    }

    const result = await generateConversationMessage({
      conversationId: ctx.params.conversation_id,
      agentId: body.agent_id,
      model: body.model,
      toolContext: body.tool_context,
    });

    ctx.status = 200;
    ctx.body =
      result.status === 'completed'
        ? {
            status: result.status,
            content: result.content,
            message: result.message,
            generation_id: result.generationId,
            trace_id: result.traceId,
            model: result.model,
          }
        : {
            status: result.status,
            generation_id: result.generationId,
            trace_id: result.traceId,
            required_action: mapGenerationRequiredAction(result.requiredAction),
          };
  }
);

export { conversationSubResourcesRouter };
