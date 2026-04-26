import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  updateSession,
} from 'src/lib/sessions';

import { sessionSubResourcesRouter } from './sessionSubResources';

export const sessionsRouter = new Router<Context>();

/**
 * Resolve the internal agent from the `agentId` URL parameter.
 * Returns the Agent model instance or null if not found.
 */
const resolveAgent = async (agentPublicId: string) => {
  return db.Agent.findOne({
    where: { publicId: agentPublicId },
  });
};

type AgentModel = Awaited<ReturnType<typeof resolveAgent>>;

const checkAgentAccess = async (
  ctx: Context,
  action: string
): Promise<{ agent: NonNullable<AgentModel> } | null> => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }
  const projectIds = await ctx.authUser.resolveProjectIds({ action });
  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  const agent = await resolveAgent(ctx.params.agentId);
  if (!agent) {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found' };
    return null;
  }
  if (projectIds && !projectIds.includes(agent.projectId)) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  return { agent };
};

// ── Create Session ───────────────────────────────────────────────────────

sessionsRouter.post('/', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const agentPublicId = ctx.params.agentId;

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:CreateSession',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(agentPublicId);
  if (!agent) {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found' };
    return;
  }

  // Verify agent belongs to an allowed project
  if (projectIds && !projectIds.includes(agent.projectId)) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    name?: string;
    actorId?: string;
    autoGenerate?: boolean;
    toolContext?: Record<string, string> | null;
  };

  const result = await createSession({
    projectId: agent.projectId,
    agentId: agent.id as number,
    name: body.name,
    actorId: body.actorId,
    autoGenerate: body.autoGenerate,
    toolContext: body.toolContext,
  });

  if (result === 'agent_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found' };
    return;
  }

  if (result === 'actor_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Actor not found' };
    return;
  }

  ctx.status = 201;
  ctx.body = result;
});

// ── List Sessions ────────────────────────────────────────────────────────

sessionsRouter.get('/', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const agentPublicId = ctx.params.agentId;

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:ListSessions',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(agentPublicId);
  if (!agent) {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found' };
    return;
  }

  if (projectIds && !projectIds.includes(agent.projectId)) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { actorId, status, limit, offset } = ctx.query as Record<
    string,
    string | undefined
  >;

  ctx.body = await listSessions({
    projectIds,
    agentId: agent.id as number,
    actorId,
    status,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
});

// ── Get Session ──────────────────────────────────────────────────────────

sessionsRouter.get('/:sessionId', async (ctx: Context) => {
  const agentAccess = await checkAgentAccess(ctx, 'agents:GetSession');
  if (!agentAccess) return;
  const { agent } = agentAccess;

  const result = await getSession({
    agentId: agent.id as number,
    sessionId: ctx.params.sessionId,
  });

  if (!result) {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  ctx.body = result;
});

// ── Update Session ───────────────────────────────────────────────────────

sessionsRouter.patch('/:sessionId', async (ctx: Context) => {
  const agentAccess = await checkAgentAccess(ctx, 'agents:UpdateSession');
  if (!agentAccess) return;
  const { agent } = agentAccess;

  const body = ctx.request.body as {
    name?: string | null;
    status?: string;
    autoGenerate?: boolean;
    toolContext?: Record<string, string> | null;
  };

  const result = await updateSession({
    agentId: agent.id as number,
    sessionId: ctx.params.sessionId,
    name: body.name,
    status: body.status,
    autoGenerate: body.autoGenerate,
    toolContext: body.toolContext,
  });

  if (!result) {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  ctx.body = result;
});

// ── Delete Session ───────────────────────────────────────────────────────

sessionsRouter.delete('/:sessionId', async (ctx: Context) => {
  const agentAccess = await checkAgentAccess(ctx, 'agents:DeleteSession');
  if (!agentAccess) return;
  const { agent } = agentAccess;

  const result = await deleteSession({
    agentId: agent.id as number,
    sessionId: ctx.params.sessionId,
  });

  if (!result) {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  ctx.status = 204;
});

// ── List Messages ────────────────────────────────────────────────────────

sessionsRouter.use(sessionSubResourcesRouter.routes());
sessionsRouter.use(sessionSubResourcesRouter.allowedMethods());

export {};
