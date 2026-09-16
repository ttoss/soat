import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  actors,
  createActor,
  deleteActor,
  findOrCreateActor,
  getActor,
  listActors,
  resolveActorLinkedIds,
  updateActor,
  validateActorExclusivity,
} from 'src/lib/actors';
import { compilePolicy } from 'src/lib/policyCompiler';
import { readTagQuery } from 'src/lib/tags';

import {
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { makeItemRouteAuthorizer } from './resourceAccess';

const actorsRouter = new Router<Context>();

/**
 * These routes already named the actor's own SRN and its tags, so what the
 * shared preamble adds is the half they were missing: a credential pinned to
 * another project now gets its own `API_KEY_PROJECT_SCOPE`, with the remedy in
 * the message, instead of an opaque `Forbidden` (the #906 class, #1339).
 *
 * `refuse` on the read too, which is what this module already answered. Whether
 * a denied read should hide the actor instead — as tools, agents and the
 * modules moved in #1339 do — is a contract change of its own, not a side
 * effect of sharing a preamble.
 */
const actorAccess = makeItemRouteAuthorizer({
  findScope: actors.findScope,
  resourceType: 'actor',
  param: 'actor_id',
  label: 'Actor',
});

type CreateActorBody = {
  project_id?: string;
  name: string;
  external_id?: string;
  instructions?: string | null;
  agent_id?: string;
  chat_id?: string;
};

actorsRouter.get('/actors', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;
  const externalId = ctx.query.external_id as string | undefined;
  const name = ctx.query.name as string | undefined;
  const agentId = ctx.query.agent_id as string | undefined;
  const chatId = ctx.query.chat_id as string | undefined;
  const conversationId = ctx.query.conversation_id as string | undefined;
  const tags = readTagQuery(ctx.query.tags);
  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'actors:ListActors',
    resourceType: 'actor',
  });

  let policyWhere: Record<string, unknown> | undefined;
  if (projectPublicId) {
    const policies = await ctx.authUser!.getPolicies(projectPublicId);
    const compiled = compilePolicy({
      policies,
      action: 'actors:ListActors',
      resourceType: 'actor',
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

  ctx.body = await listActors({
    projectIds,
    externalId,
    name,
    agentId,
    chatId,
    conversationId,
    tags,
    policyWhere,
    limit,
    offset,
  });
});

actorsRouter.get('/actors/:actor_id', async (ctx: Context) => {
  await actorAccess.authorize({
    ctx,
    action: 'actors:GetActor',
    onDenied: 'refuse',
  });

  ctx.body = await getActor({ id: ctx.params.actor_id });
});

const performCreateActor = async (args: {
  project: { id: number };
  body: CreateActorBody;
  agentDbId: number | undefined;
  chatDbId: number | undefined;
}): Promise<{ status: 200 | 201; actor: unknown }> => {
  const instructions = args.body.instructions ?? null;

  if (args.body.external_id !== undefined) {
    const result = await findOrCreateActor({
      projectId: args.project.id!,
      externalId: args.body.external_id,
      name: args.body.name,
      instructions,
      agentId: args.agentDbId,
      chatId: args.chatDbId,
    });
    return { status: result.created ? 201 : 200, actor: result.actor };
  }

  const actor = await createActor({
    projectId: args.project.id!,
    name: args.body.name,
    externalId: args.body.external_id,
    instructions,
    agentId: args.agentDbId,
    chatId: args.chatDbId,
  });

  return { status: 201 as const, actor };
};

const validateCreateActorBody = (body: CreateActorBody): string | null => {
  return validateActorExclusivity({
    agentId: body.agent_id,
    chatId: body.chat_id,
  });
};

actorsRouter.post('/actors', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as CreateActorBody;
  const validationError = validateCreateActorBody(body);
  if (validationError) {
    throw new DomainError('VALIDATION_FAILED', validationError);
  }

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'actors:CreateActor',
    resourceType: 'actor',
  });
  const projectDbId = Number(targetProjectId);
  const resolved = await resolveActorLinkedIds({
    agentId: body.agent_id,
    chatId: body.chat_id,
    projectId: projectDbId,
  });

  const result = await performCreateActor({
    project: { id: projectDbId },
    body,
    agentDbId: resolved.agentId ?? undefined,
    chatDbId: resolved.chatId ?? undefined,
  });

  ctx.status = result.status;
  ctx.body = result.actor;
});

actorsRouter.delete('/actors/:actor_id', async (ctx: Context) => {
  await actorAccess.authorizeWrite({ ctx, action: 'actors:DeleteActor' });

  await deleteActor({ id: ctx.params.actor_id });
  ctx.status = 204;
});

actorsRouter.patch('/actors/:actor_id', async (ctx: Context) => {
  await actorAccess.authorizeWrite({ ctx, action: 'actors:UpdateActor' });

  const body = ctx.request.body as {
    name?: string;
    external_id?: string;
    instructions?: string | null;
    agent_id?: string | null;
    chat_id?: string | null;
  };

  const updated = await updateActor({
    id: ctx.params.actor_id,
    name: body.name,
    externalId: body.external_id,
    instructions: body.instructions,
    agentId: body.agent_id,
    chatId: body.chat_id,
  });

  ctx.body = updated;
});

export { actorsRouter };
