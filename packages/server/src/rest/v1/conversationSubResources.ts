import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
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
import { mapGeneratedTurn } from 'src/lib/generatedTurn';
import { NO_PROVENANCE } from 'src/lib/generationProvenance';
import { buildSrn } from 'src/lib/iam';
import { readNullableMetadataBag } from 'src/lib/metadataBag';
import { assertAllowedUnder } from 'src/lib/turnAuthority';
import { captureAuthority } from 'src/lib/workAuthority';

import { requireConversationAccess } from './conversationHelpers';
import { resolveStreamWait, respondAcceptedTurn } from './generationStream';
import {
  type AuthenticatedContext,
  parsePagination,
  parseToolContextBody,
  requestPrincipalFromCtx,
  requireAuth,
} from './helpers';
import { registerTagRoutes, type TagAccess } from './tagRoutes';

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

    await requireConversationAccess({
      ctx,
      conversation,
      action: 'conversations:GetConversation',
      notFound: new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found'),
    });

    const { limit, cursor } = parsePagination(ctx);
    const { order } = ctx.query;
    if (order !== undefined && order !== 'asc' && order !== 'desc') {
      throw new DomainError(
        'VALIDATION_FAILED',
        `order must be asc or desc; got ${JSON.stringify(order)}.`,
        { field: 'order' }
      );
    }

    const messages = await listConversationMessages({
      conversationId: ctx.params.conversation_id,
      order,
      limit,
      cursor,
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
      metadata?: unknown;
      file_ids?: string[];
    };

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });

    if (!conversation) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found.');
    }

    await requireConversationAccess({
      ctx,
      conversation,
      action: 'conversations:UpdateConversation',
      notFound: new DomainError(
        'RESOURCE_NOT_FOUND',
        'Conversation not found.'
      ),
    });

    const message = await addConversationMessage({
      conversationId: ctx.params.conversation_id,
      message: body.message,
      role: body.role,
      actorId: body.actor_id ?? null,
      position: body.position,
      metadata: readNullableMetadataBag(body.metadata) ?? undefined,
      files: body.file_ids?.length
        ? {
            ids: body.file_ids,
            authority: captureAuthority({ authUser: ctx.authUser }),
            authUser: ctx.authUser,
          }
        : undefined,
      // Caller-written text: it carries no block that feeds a counter.
      provenance: NO_PROVENANCE,
      embedAs: requestPrincipalFromCtx(ctx),
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

    await requireConversationAccess({
      ctx,
      conversation,
      action: 'conversations:UpdateConversation',
      notFound: new DomainError(
        'RESOURCE_NOT_FOUND',
        'Conversation not found.'
      ),
    });

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

const resolveConversation = async (args: {
  ctx: AuthenticatedContext;
  access: TagAccess;
}) => {
  const conversation = await getConversation({
    id: args.ctx.params.conversation_id,
  });

  if (!conversation) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
  }

  await requireConversationAccess({
    ctx: args.ctx,
    conversation,
    action:
      args.access === 'read'
        ? 'conversations:GetConversation'
        : 'conversations:UpdateConversation',
    notFound: new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found'),
  });

  return conversation;
};

registerTagRoutes({
  router: conversationSubResourcesRouter,
  path: '/conversations/:conversation_id/tags',
  resolve: resolveConversation,
  readTags: ({ resource }) => {
    return getConversationTags({ id: resource.id });
  },
  writeTags: ({ resource, tags, merge }) => {
    return updateConversationTags({ id: resource.id, tags, merge });
  },
});

conversationSubResourcesRouter.post(
  '/conversations/:conversation_id/generate',
  async (ctx: Context) => {
    requireAuth(ctx);

    const body = ctx.request.body as {
      agent_id: string;
      model?: string;
      stream?: boolean;
      tool_context?: unknown;
    };

    const stream = body.stream === true;
    const wait = resolveStreamWait({ ctx, stream });

    const conversation = await getConversation({
      id: ctx.params.conversation_id,
    });
    if (!conversation) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
    }

    await requireConversationAccess({
      ctx,
      conversation,
      action: 'conversations:GenerateConversationMessage',
      notFound: new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found'),
    });

    const turn = {
      conversationId: ctx.params.conversation_id,
      agentId: body.agent_id,
      model: body.model,
      toolContext: parseToolContextBody({
        raw: body.tool_context,
        reservedPrefix: 'refuse',
      }),
      authority: captureAuthority({ authUser: ctx.authUser }),
      authUser: ctx.authUser,
    };

    // Resolved and checked first either way, so an unknown agent or one the
    // caller may not run is a synchronous answer, not one found by polling.
    const { generatingAgent } = await resolveConversationAndAgent({
      conversationId: ctx.params.conversation_id,
      agentId: body.agent_id,
    });
    const projectPublicId = conversation.project_id as string;
    await assertAllowedUnder({
      authority: turn.authority,
      caller: ctx.authUser,
      checks: [
        {
          projectPublicId,
          action: 'agents:CreateAgentGeneration',
          resource: buildSrn({
            projectPublicId,
            resourceType: 'agent',
            resourceId: generatingAgent.publicId as string,
          }),
        },
      ],
    });

    if (stream || !wait) {
      // The reply lands as a conversation message; a failure after the
      // record exists is on the generation the caller polls.
      await respondAcceptedTurn({
        ctx,
        stream,
        handle: { conversation_id: ctx.params.conversation_id },
        label: 'conversation generate stream',
        start: async (onRecorded) => {
          const result = await generateConversationMessage({
            ...turn,
            onRecorded,
          });
          return {
            generationId: result.generationId,
            traceId: result.traceId,
          };
        },
      });
      return;
    }

    const result = await generateConversationMessage(turn);

    ctx.status = 200;
    ctx.body = mapGeneratedTurn(result);
  }
);

export { conversationSubResourcesRouter };
