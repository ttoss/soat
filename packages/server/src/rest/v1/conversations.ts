import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  updateConversation,
} from 'src/lib/conversations';
import { compilePolicy } from 'src/lib/policyCompiler';

import { checkConversationAccess } from './conversationHelpers';
import { conversationSubResourcesRouter } from './conversationSubResources';
import {
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

const conversationsRouter = new Router<Context>();

conversationsRouter.get('/conversations', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;
  const actorId = ctx.query.actor_id as string | undefined;
  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'conversations:ListConversations',
    resourceType: 'conversation',
  });

  let policyWhere: Record<string, unknown> | undefined;
  if (projectPublicId) {
    const policies = await ctx.authUser!.getPolicies(projectPublicId);
    const compiled = compilePolicy({
      policies,
      action: 'conversations:ListConversations',
      resourceType: 'conversation',
      projectPublicId,
    });
    if (!compiled.hasAccess) {
      ctx.body = {
        data: [],
        total: 0,
        limit: limit ?? 50,
        offset: offset ?? 0,
      };
      return;
    }
    policyWhere = compiled.where;
  }

  ctx.body = await listConversations({
    projectIds,
    actorId,
    policyWhere,
    limit,
    offset,
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
      throw new DomainError('FORBIDDEN', 'Forbidden');
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
  });
  ctx.status = 201;
  ctx.body = conversation;
});

conversationsRouter.patch(
  '/conversations/:conversation_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    const body = ctx.request.body as { status?: string; name?: string | null };

    if (body.status === undefined && body.name === undefined) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'At least one of status or name is required'
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
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    const updated = await updateConversation({
      id: ctx.params.conversation_id,
      status: body.status,
      name: body.name,
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
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    await deleteConversation({ id: ctx.params.conversation_id });

    ctx.status = 204;
  }
);

conversationsRouter.use(conversationSubResourcesRouter.routes());
conversationsRouter.use(conversationSubResourcesRouter.allowedMethods());

export { conversationsRouter };
