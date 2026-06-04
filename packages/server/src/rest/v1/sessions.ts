import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
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

/**
 * Resolves the agent for the current request and verifies the authenticated
 * user has access to it.
 *
 * Throws `DomainError` with codes:
 *  - `UNAUTHORIZED`       – no authenticated user
 *  - `FORBIDDEN`          – user has no project access or agent belongs to a
 *                           project the user cannot access
 *  - `RESOURCE_NOT_FOUND` – agent does not exist
 */
const checkAgentAccess = async (
  ctx: Context,
  action: string
): Promise<{ agent: NonNullable<AgentModel> }> => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }
  const projectIds = await ctx.authUser.resolveProjectIds({ action });
  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
  const agent = await resolveAgent(ctx.params.agent_id);
  if (!agent) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Agent not found');
  }
  if (projectIds && !projectIds.includes(agent.projectId)) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
  return { agent };
};

// ── Create Session ───────────────────────────────────────────────────────

sessionsRouter.post('/', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const agentPublicId = ctx.params.agent_id;

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:CreateSession',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const agent = await resolveAgent(agentPublicId);
  if (!agent) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Agent not found');
  }

  // Verify agent belongs to an allowed project
  if (projectIds && !projectIds.includes(agent.projectId)) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const body = ctx.request.body as {
    name?: string;
    actorId?: string;
    autoGenerate?: boolean;
    toolContext?: Record<string, string> | null;
    inactivityTtlSeconds?: number;
  };

  const result = await createSession({
    projectId: agent.projectId,
    agentId: agent.id as number,
    name: body.name,
    actorId: body.actorId,
    autoGenerate: body.autoGenerate,
    toolContext: body.toolContext,
    inactivityTtlSeconds: body.inactivityTtlSeconds,
  });

  ctx.status = 201;
  ctx.body = result;
});

// ── List Sessions ────────────────────────────────────────────────────────

sessionsRouter.get('/', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const agentPublicId = ctx.params.agent_id;

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:ListSessions',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const agent = await resolveAgent(agentPublicId);
  if (!agent) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Agent not found');
  }

  if (projectIds && !projectIds.includes(agent.projectId)) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
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

sessionsRouter.get('/:session_id', async (ctx: Context) => {
  const { agent } = await checkAgentAccess(ctx, 'agents:GetSession');

  const result = await getSession({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
  });

  ctx.body = result;
});

// ── Update Session ───────────────────────────────────────────────────────

sessionsRouter.patch('/:session_id', async (ctx: Context) => {
  const { agent } = await checkAgentAccess(ctx, 'agents:UpdateSession');

  const body = ctx.request.body as {
    name?: string | null;
    status?: string;
    autoGenerate?: boolean;
    toolContext?: Record<string, string> | null;
  };

  const result = await updateSession({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
    name: body.name,
    status: body.status,
    autoGenerate: body.autoGenerate,
    toolContext: body.toolContext,
  });

  ctx.body = result;
});

// ── Delete Session ───────────────────────────────────────────────────────

sessionsRouter.delete('/:session_id', async (ctx: Context) => {
  const { agent } = await checkAgentAccess(ctx, 'agents:DeleteSession');

  await deleteSession({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
  });

  ctx.status = 204;
});

// ── List Messages ────────────────────────────────────────────────────────

sessionsRouter.use(sessionSubResourcesRouter.routes());
sessionsRouter.use(sessionSubResourcesRouter.allowedMethods());

export {};
