import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import {
  createSession,
  deleteSession,
  findSessionAccess,
  getSession,
  listSessions,
  updateSession,
} from 'src/lib/sessions';

import { sessionSubResourcesRouter } from './sessionSubResources';

export const sessionsRouter = new Router<Context>();

/**
 * Resolves a session by its (globally unique) id and verifies the authenticated
 * user can access the project it belongs to.
 *
 * Throws `DomainError` with codes:
 *  - `UNAUTHORIZED`       – no authenticated user
 *  - `FORBIDDEN`          – user has no project access or the session belongs to
 *                           a project the user cannot access
 *  - `RESOURCE_NOT_FOUND` – session does not exist
 */
export const checkSessionAccess = async (
  ctx: Context,
  action: string
): Promise<{ agentId: number; agentPublicId: string; projectId: number }> => {
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
  const access = await findSessionAccess({ sessionId: ctx.params.session_id });
  if (!access) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }
  if (projectIds && !projectIds.includes(access.projectId)) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
  return access;
};

// ── Create Session ───────────────────────────────────────────────────────

sessionsRouter.post('/sessions', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const body = ctx.request.body as {
    agentId?: string;
    name?: string;
    actorId?: string;
    autoGenerate?: boolean;
    toolContext?: Record<string, string> | null;
    inactivityTtlSeconds?: number;
    messageDelaySeconds?: number | null;
  };

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:CreateSession',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const agent = await db.Agent.findOne({ where: { publicId: body.agentId } });
  if (!agent) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Agent not found');
  }

  // Verify agent belongs to an allowed project
  if (projectIds && !projectIds.includes(agent.projectId)) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const result = await createSession({
    projectId: agent.projectId,
    agentId: agent.id as number,
    name: body.name,
    actorId: body.actorId,
    autoGenerate: body.autoGenerate,
    toolContext: body.toolContext,
    inactivityTtlSeconds: body.inactivityTtlSeconds,
    messageDelaySeconds: body.messageDelaySeconds,
  });

  ctx.status = 201;
  ctx.body = result;
});

// ── List Sessions ────────────────────────────────────────────────────────

sessionsRouter.get('/sessions', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:ListSessions',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const { agentId, actorId, status, limit, offset } = ctx.query as Record<
    string,
    string | undefined
  >;

  ctx.body = await listSessions({
    projectIds,
    agentId,
    actorId,
    status,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
});

// ── Get Session ──────────────────────────────────────────────────────────

sessionsRouter.get('/sessions/:session_id', async (ctx: Context) => {
  const { agentId } = await checkSessionAccess(ctx, 'agents:GetSession');

  ctx.body = await getSession({
    agentId,
    sessionId: ctx.params.session_id,
  });
});

// ── Update Session ───────────────────────────────────────────────────────

sessionsRouter.patch('/sessions/:session_id', async (ctx: Context) => {
  const { agentId } = await checkSessionAccess(ctx, 'agents:UpdateSession');

  const body = ctx.request.body as {
    name?: string | null;
    status?: string;
    autoGenerate?: boolean;
    toolContext?: Record<string, string> | null;
    inactivityTtlSeconds?: number;
    messageDelaySeconds?: number | null;
  };

  ctx.body = await updateSession({
    agentId,
    sessionId: ctx.params.session_id,
    name: body.name,
    status: body.status,
    autoGenerate: body.autoGenerate,
    toolContext: body.toolContext,
    inactivityTtlSeconds: body.inactivityTtlSeconds,
    messageDelaySeconds: body.messageDelaySeconds,
  });
});

// ── Delete Session ───────────────────────────────────────────────────────

sessionsRouter.delete('/sessions/:session_id', async (ctx: Context) => {
  const { agentId } = await checkSessionAccess(ctx, 'agents:DeleteSession');

  await deleteSession({
    agentId,
    sessionId: ctx.params.session_id,
  });

  ctx.status = 204;
});

// ── Sub-resources (messages, generate, tool-outputs, tags) ─────────────────

sessionsRouter.use(sessionSubResourcesRouter.routes());
sessionsRouter.use(sessionSubResourcesRouter.allowedMethods());
