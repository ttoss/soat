import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { createActor } from 'src/lib/actors';
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
} from 'src/lib/agents';

import { agentGenerationRouter } from './agentGeneration';
import { sessionsRouter } from './sessions';

export const agentsRouter = new Router<Context>();

// ── Sessions (sub-resource) ──────────────────────────────────────────────

agentsRouter.use(
  '/agents/:agent_id/sessions',
  sessionsRouter.routes(),
  sessionsRouter.allowedMethods()
);

// ── Agents CRUD ──────────────────────────────────────────────────────────

type CreateAgentBody = {
  aiProviderId?: unknown;
  name?: unknown;
  instructions?: unknown;
  model?: unknown;
  toolIds?: unknown;
  maxSteps?: unknown;
  toolChoice?: unknown;
  stopConditions?: unknown;
  activeToolIds?: unknown;
  stepRules?: unknown;
  boundaryPolicy?: unknown;
  temperature?: unknown;
  knowledgeConfig?: unknown;
  projectId?: string;
};

const parseNullableString = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return undefined;
};

const parseOptional = <T>(v: unknown): T | undefined => {
  return v !== undefined ? (v as T) : undefined;
};

const parseUpdateAgentBody = (body: Record<string, unknown>) => {
  return {
    aiProviderId:
      typeof body.aiProviderId === 'string' ? body.aiProviderId : undefined,
    name: parseNullableString(body.name),
    instructions: parseNullableString(body.instructions),
    model: parseNullableString(body.model),
    toolIds: parseOptional<string[] | null>(body.toolIds),
    maxSteps: parseOptional<number | null>(body.maxSteps),
    toolChoice: parseOptional<object | null>(body.toolChoice),
    stopConditions: parseOptional<object[] | null>(body.stopConditions),
    activeToolIds: parseOptional<string[] | null>(body.activeToolIds),
    stepRules: parseOptional<object[] | null>(body.stepRules),
    boundaryPolicy: parseOptional<object | null>(body.boundaryPolicy),
    temperature: parseOptional<number | null>(body.temperature),
    knowledgeConfig: parseOptional<object | null>(body.knowledgeConfig),
  };
};

const resolveAgentProjectId = async (
  authUser: NonNullable<Context['authUser']>,
  projectPublicId: string | undefined
): Promise<number | 403 | 400> => {
  const projectIds = await authUser.resolveProjectIds({
    projectPublicId,
    action: 'agents:CreateAgent',
  });
  if (projectIds === null) return 403;
  let targetProjectId = projectIds?.[0];
  /* istanbul ignore next */
  if (!targetProjectId && authUser.apiKeyProjectId) {
    const project = await db.Project.findOne({
      where: { id: authUser.apiKeyProjectId },
    });
    if (project) targetProjectId = project.id as number;
  }
  /* istanbul ignore next */
  if (!targetProjectId) return 400;
  return targetProjectId;
};

const buildCreateAgentArgs = (
  projectId: number,
  body: CreateAgentBody
): Parameters<typeof createAgent>[0] => {
  return {
    projectId,
    aiProviderId: body.aiProviderId as string,
    name: typeof body.name === 'string' ? body.name : undefined,
    instructions:
      typeof body.instructions === 'string' ? body.instructions : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    toolIds: Array.isArray(body.toolIds) ? body.toolIds : undefined,
    maxSteps: typeof body.maxSteps === 'number' ? body.maxSteps : undefined,
    toolChoice: body.toolChoice as object | undefined,
    stopConditions: Array.isArray(body.stopConditions)
      ? body.stopConditions
      : undefined,
    activeToolIds: Array.isArray(body.activeToolIds)
      ? body.activeToolIds
      : undefined,
    stepRules: Array.isArray(body.stepRules) ? body.stepRules : undefined,
    boundaryPolicy: body.boundaryPolicy as object | undefined,
    temperature:
      typeof body.temperature === 'number' ? body.temperature : undefined,
    knowledgeConfig: body.knowledgeConfig as object | undefined,
  };
};

agentsRouter.post('/agents', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const reqBody = ctx.request.body as CreateAgentBody;

  if (!reqBody.aiProviderId || typeof reqBody.aiProviderId !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'aiProviderId is required' };
    return;
  }

  const targetProjectId = await resolveAgentProjectId(
    ctx.authUser,
    reqBody.projectId
  );

  if (targetProjectId === 403) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  /* istanbul ignore next */
  if (targetProjectId === 400) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return;
  }

  const result = await createAgent(
    buildCreateAgentArgs(targetProjectId, reqBody)
  );

  ctx.status = 201;
  ctx.body = result;
});

agentsRouter.get('/agents', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'agents:ListAgents',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listAgents({ projectIds });
});

agentsRouter.get('/agents/:agent_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:GetAgent',
  });

  /* istanbul ignore next */
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await getAgent({
    projectIds,
    id: ctx.params.agent_id,
  });

  ctx.body = result;
});

agentsRouter.put('/agents/:agent_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:UpdateAgent',
  });

  /* istanbul ignore next */
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as Record<string, unknown>;

  const result = await updateAgent({
    projectIds,
    id: ctx.params.agent_id,
    ...parseUpdateAgentBody(body),
  });

  ctx.body = result;
});

agentsRouter.delete('/agents/:agent_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:DeleteAgent',
  });

  /* istanbul ignore next */
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteAgent({
    projectIds,
    id: ctx.params.agent_id,
  });

  ctx.status = 204;
});

// ── Generation ───────────────────────────────────────────────────────────

agentsRouter.use(agentGenerationRouter.routes());
agentsRouter.use(agentGenerationRouter.allowedMethods());

agentsRouter.post('/agents/:agent_id/actors', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const agent = await db.Agent.findOne({
    where: { publicId: ctx.params.agent_id },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!agent) {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found' };
    return;
  }

  const project = (
    agent as unknown as {
      project?: InstanceType<(typeof db)['Project']>;
    }
  ).project;

  if (!project?.publicId) {
    ctx.status = 404;
    ctx.body = { error: 'Agent project not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: project.publicId,
    action: 'actors:CreateActor',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    name: string;
    type?: string;
    externalId?: string;
    instructions?: string | null;
  };

  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  const actor = await createActor({
    projectId: agent.projectId,
    name: body.name,
    externalId: body.externalId,
    instructions: body.instructions ?? null,
    agentId: agent.id as number,
  });

  ctx.status = 201;
  ctx.body = actor;
});
