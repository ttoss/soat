import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createActor,
  deleteActor,
  findOrCreateActor,
  getActor,
  listActors,
  resolveActorLinkedIds,
  updateActor,
  validateActorExclusivity,
} from 'src/lib/actors';
import { buildSrn } from 'src/lib/iam';
import { compilePolicy } from 'src/lib/policyCompiler';

import {
  checkAuth,
  resolveProjectIdsWithAction,
  resolveWriteProjectId,
} from './helpers';

const actorsRouter = new Router<Context>();

type CreateActorBody = {
  project_id?: string;
  name: string;
  external_id?: string;
  instructions?: string | null;
  agent_id?: string;
  chat_id?: string;
  memory_id?: string;
  auto_create_memory?: boolean;
};

actorsRouter.get('/actors', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.project_id as string | undefined;
  const externalId = ctx.query.external_id as string | undefined;
  const name = ctx.query.name as string | undefined;
  const agentId = ctx.query.agent_id as string | undefined;
  const chatId = ctx.query.chat_id as string | undefined;
  const conversationId = ctx.query.conversation_id as string | undefined;
  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;

  const projectIds = await resolveProjectIdsWithAction({
    ctx,
    projectPublicId,
    action: 'actors:ListActors',
    resourceType: 'actor',
  });

  if (projectIds === null) return;

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
    policyWhere,
    limit,
    offset,
  });
});

actorsRouter.get('/actors/:actor_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const actor = await getActor({ id: ctx.params.actor_id });

  const srnGet = buildSrn({
    projectPublicId: actor.project_id!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const contextGet: Record<string, string> = { 'soat:ResourceType': 'actor' };
  for (const [k, v] of Object.entries(actor.tags!)) {
    contextGet[`soat:ResourceTag/${k}`] = v as string;
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.project_id!,
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

const performCreateActor = async (args: {
  project: { id: number };
  body: CreateActorBody;
  agentDbId: number | undefined;
  chatDbId: number | undefined;
  memoryDbId: number | undefined;
}): Promise<{ status: 200 | 201; actor: unknown }> => {
  const instructions = args.body.instructions ?? null;
  const autoCreateMemory = args.body.auto_create_memory ?? false;
  const memoryId = args.memoryDbId ?? null;

  if (args.body.external_id !== undefined) {
    const result = await findOrCreateActor({
      projectId: args.project.id!,
      externalId: args.body.external_id,
      name: args.body.name,
      instructions,
      agentId: args.agentDbId,
      chatId: args.chatDbId,
      memoryId,
      autoCreateMemory,
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
    memoryId,
    autoCreateMemory,
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
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as CreateActorBody;
  const validationError = validateCreateActorBody(body);
  if (validationError) {
    ctx.status = 400;
    ctx.body = { error: validationError };
    return;
  }

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'actors:CreateActor',
    resourceType: 'actor',
  });
  if (targetProjectId === null) return;

  const projectDbId = Number(targetProjectId);
  const resolved = await resolveActorLinkedIds({
    agentId: body.agent_id,
    chatId: body.chat_id,
    memoryId: body.memory_id,
    projectId: projectDbId,
  });

  const result = await performCreateActor({
    project: { id: projectDbId },
    body,
    agentDbId: resolved.agentId ?? undefined,
    chatDbId: resolved.chatId ?? undefined,
    memoryDbId: resolved.memoryId ?? undefined,
  });

  ctx.status = result.status;
  ctx.body = result.actor;
});

actorsRouter.delete('/actors/:actor_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const actor = await getActor({ id: ctx.params.actor_id });

  const srnDel = buildSrn({
    projectPublicId: actor.project_id!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const contextDel: Record<string, string> = { 'soat:ResourceType': 'actor' };
  for (const [k, v] of Object.entries(actor.tags!)) {
    contextDel[`soat:ResourceTag/${k}`] = v as string;
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.project_id!,
    action: 'actors:DeleteActor',
    resource: srnDel,
    context: contextDel,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteActor({ id: ctx.params.actor_id });
  ctx.status = 204;
});

actorsRouter.patch('/actors/:actor_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const actor = await getActor({ id: ctx.params.actor_id });

  const srnUpd = buildSrn({
    projectPublicId: actor.project_id!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const contextUpd: Record<string, string> = { 'soat:ResourceType': 'actor' };
  for (const [k, v] of Object.entries(actor.tags!)) {
    contextUpd[`soat:ResourceTag/${k}`] = v as string;
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.project_id!,
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
    external_id?: string;
    instructions?: string | null;
    agent_id?: string | null;
    chat_id?: string | null;
    memory_id?: string | null;
  };

  const updated = await updateActor({
    id: ctx.params.actor_id,
    name: body.name,
    externalId: body.external_id,
    instructions: body.instructions,
    agentId: body.agent_id,
    chatId: body.chat_id,
    memoryId: body.memory_id,
  });

  ctx.body = updated;
});

export { actorsRouter };
