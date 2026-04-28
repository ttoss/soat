import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
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

    ctx.body = conversation;
  }
);

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
    if (ctx.authUser.apiKeyProjectPublicId) {
      resolvedProjectPublicId = ctx.authUser.apiKeyProjectPublicId;
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

conversationsRouter.patch(
  '/conversations/:conversation_id',
  async (ctx: Context) => {
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
        'conversations:DeleteConversation'
      ))
    ) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    await deleteConversation({ id: ctx.params.conversation_id });

    ctx.status = 204;
  }
);

conversationsRouter.use(conversationSubResourcesRouter.routes());
conversationsRouter.use(conversationSubResourcesRouter.allowedMethods());

export { conversationsRouter };
