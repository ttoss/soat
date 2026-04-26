import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  addSessionMessage,
  createSession,
  deleteSession,
  generateSessionResponse,
  getSession,
  getSessionTags,
  listSessionMessages,
  listSessions,
  submitSessionToolOutputs,
  updateSession,
  updateSessionTags,
} from 'src/lib/sessions';

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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:GetSession',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(ctx.params.agentId);
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:UpdateSession',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(ctx.params.agentId);
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:DeleteSession',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(ctx.params.agentId);
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

sessionsRouter.get('/:sessionId/messages', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:GetSession',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(ctx.params.agentId);
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

  const { limit, offset } = ctx.query as Record<string, string | undefined>;

  const result = await listSessionMessages({
    agentId: agent.id as number,
    sessionId: ctx.params.sessionId,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });

  if (!result) {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  ctx.body = result;
});

// ── Add Message ──────────────────────────────────────────────────────────

sessionsRouter.post('/:sessionId/messages', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:SendSessionMessage',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(ctx.params.agentId);
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

  const body = ctx.request.body as {
    message?: string;
    toolContext?: Record<string, string>;
  };

  if (!body.message || typeof body.message !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'message is required' };
    return;
  }

  const result = await addSessionMessage({
    agentId: agent.id as number,
    sessionId: ctx.params.sessionId,
    message: body.message,
    toolContext: body.toolContext,
  });

  if (result === 'session_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  ctx.status = 201;
  ctx.body = result;
});

// ── Generate Response ────────────────────────────────────────────────────

sessionsRouter.post('/:sessionId/generate', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:SendSessionMessage',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(ctx.params.agentId);
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

  const body =
    (ctx.request.body as {
      model?: string;
      toolContext?: Record<string, string>;
    }) ?? {};
  const isAsync = ctx.query['async'] === 'true';

  if (isAsync) {
    generateSessionResponse({
      agentId: agent.id as number,
      sessionId: ctx.params.sessionId,
      model: body.model,
      toolContext: body.toolContext,
    }).catch(() => {
      // Fire-and-forget: errors are emitted via event bus
    });
    ctx.status = 202;
    ctx.body = { status: 'accepted', sessionId: ctx.params.sessionId };
    return;
  }

  const result = await generateSessionResponse({
    agentId: agent.id as number,
    sessionId: ctx.params.sessionId,
    model: body.model,
    toolContext: body.toolContext,
  });

  if (result === 'session_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  if (result === 'already_generating') {
    ctx.status = 409;
    ctx.body = { error: 'Generation already in progress' };
    return;
  }

  if (typeof result === 'string') {
    ctx.status = 500;
    ctx.body = { error: result };
    return;
  }

  ctx.body = result;
});

// ── Submit Tool Outputs ──────────────────────────────────────────────────

sessionsRouter.post('/:sessionId/tool-outputs', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:SubmitSessionToolOutputs',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(ctx.params.agentId);
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

  const body = ctx.request.body as {
    generationId?: string;
    toolOutputs?: Array<{ toolCallId: string; output: unknown }>;
  };

  if (!body.generationId || typeof body.generationId !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'generationId is required' };
    return;
  }

  if (!Array.isArray(body.toolOutputs) || body.toolOutputs.length === 0) {
    ctx.status = 400;
    ctx.body = {
      error: 'toolOutputs is required and must be a non-empty array',
    };
    return;
  }

  const result = await submitSessionToolOutputs({
    agentId: agent.id as number,
    agentPublicId: ctx.params.agentId,
    sessionId: ctx.params.sessionId,
    generationId: body.generationId,
    toolOutputs: body.toolOutputs,
  });

  if (result === 'session_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found' };
    return;
  }

  if (result === 'generation_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Generation not found' };
    return;
  }

  ctx.body = result;
});

// ── Tags ─────────────────────────────────────────────────────────────────

sessionsRouter.get('/:sessionId/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:GetSession',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(ctx.params.agentId);
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

  const result = await getSessionTags({
    agentId: agent.id as number,
    sessionId: ctx.params.sessionId,
  });

  if (result === null) {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  ctx.body = result;
});

sessionsRouter.put('/:sessionId/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:UpdateSession',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(ctx.params.agentId);
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

  const tags = ctx.request.body as Record<string, string>;

  const result = await updateSessionTags({
    agentId: agent.id as number,
    sessionId: ctx.params.sessionId,
    tags,
    merge: false,
  });

  if (result === null) {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  ctx.body = result;
});

sessionsRouter.patch('/:sessionId/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:UpdateSession',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const agent = await resolveAgent(ctx.params.agentId);
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

  const tags = ctx.request.body as Record<string, string>;

  const result = await updateSessionTags({
    agentId: agent.id as number,
    sessionId: ctx.params.sessionId,
    tags,
    merge: true,
  });

  if (result === null) {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  ctx.body = result;
});
