import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { readRetrievalMode } from 'src/lib/conversationRetrieval';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  updateConversation,
} from 'src/lib/conversations';
import { emptyPage } from 'src/lib/pagination';
import { readTagQuery } from 'src/lib/tags';

import { checkConversationAccess } from './conversationHelpers';
import { conversationSubResourcesRouter } from './conversationSubResources';
import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { compileReadPolicy } from './readPolicy';
import { resourceRefusal } from './resourceAccess';

const conversationsRouter = new Router<Context>();

conversationsRouter.get('/conversations', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;
  const actorId = ctx.query.actor_id as string | undefined;
  const tags = readTagQuery(ctx.query.tags);
  const { limit, cursor } = parsePagination(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'conversations:ListConversations',
    resourceType: 'conversation',
  });

  const { where: policyWhere, hasAccess } = await compileReadPolicy({
    ctx,
    projectPublicId,
    projectIds,
    action: 'conversations:ListConversations',
    resourceType: 'conversation',
  });
  if (!hasAccess) {
    ctx.body = emptyPage({ limit, cursor });
    return;
  }

  ctx.body = await listConversations({
    projectIds,
    actorId,
    tags,
    policyWhere,
    limit,
    cursor,
  });
});

conversationsRouter.get(
  '/conversations/:conversation_id',
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
      throw await resourceRefusal({
        ctx,
        projectPublicId: conversation.project_id!,
        notFound: new DomainError(
          'RESOURCE_NOT_FOUND',
          'Conversation not found'
        ),
      });
    }

    ctx.body = conversation;
  }
);

conversationsRouter.post('/conversations', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    status?: string;
    name?: string | null;
    actor_id?: string | null;
    retrieval?: unknown;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'conversations:CreateConversation',
    resourceType: 'conversation',
  });
  let resolvedActorId: number | null = null;
  if (body.actor_id) {
    const actor = await db.Actor.findOne({
      where: { publicId: body.actor_id },
    });
    if (!actor) {
      throw new DomainError('VALIDATION_FAILED', 'Invalid actor ID');
    }
    resolvedActorId = actor.id;
  }

  const conversation = await createConversation({
    projectId: Number(targetProjectId),
    status: body.status,
    name: body.name ?? null,
    actorId: resolvedActorId,
    retrieval:
      body.retrieval === undefined || body.retrieval === null
        ? null
        : readRetrievalMode(body.retrieval),
  });
  ctx.status = 201;
  ctx.body = conversation;
});

conversationsRouter.patch(
  '/conversations/:conversation_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    const body = ctx.request.body as {
      status?: string;
      name?: string | null;
      retrieval?: unknown;
    };

    if (
      body.status === undefined &&
      body.name === undefined &&
      body.retrieval === undefined
    ) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'At least one of status, name or retrieval is required'
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
        'conversations:UpdateConversation'
      ))
    ) {
      throw await resourceRefusal({
        ctx,
        projectPublicId: conversation.project_id!,
        notFound: new DomainError(
          'RESOURCE_NOT_FOUND',
          'Conversation not found'
        ),
      });
    }

    const updated = await updateConversation({
      id: ctx.params.conversation_id,
      status: body.status,
      name: body.name,
      retrieval:
        body.retrieval === undefined
          ? undefined
          : body.retrieval === null
            ? null
            : readRetrievalMode(body.retrieval),
    });

    ctx.body = updated;
  }
);

conversationsRouter.delete(
  '/conversations/:conversation_id',
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
        'conversations:DeleteConversation'
      ))
    ) {
      throw await resourceRefusal({
        ctx,
        projectPublicId: conversation.project_id!,
        notFound: new DomainError(
          'RESOURCE_NOT_FOUND',
          'Conversation not found'
        ),
      });
    }

    await deleteConversation({ id: ctx.params.conversation_id });

    ctx.status = 204;
  }
);

conversationsRouter.use(conversationSubResourcesRouter.routes());
conversationsRouter.use(conversationSubResourcesRouter.allowedMethods());

export { conversationsRouter };
