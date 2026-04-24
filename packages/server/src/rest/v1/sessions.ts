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
  sendSessionMessage,
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

/**
 * @openapi
 * /agents/{agentId}/sessions:
 *   post:
 *     tags: [Sessions]
 *     summary: Create a new session
 *     operationId: createSession
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateSessionRequest'
 *     responses:
 *       '201':
 *         description: Session created
 */
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

/**
 * @openapi
 * /agents/{agentId}/sessions:
 *   get:
 *     tags: [Sessions]
 *     summary: List sessions for an agent
 *     operationId: listSessions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: actorId
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *     responses:
 *       '200':
 *         description: List of sessions
 */
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

/**
 * @openapi
 * /agents/{agentId}/sessions/{sessionId}:
 *   get:
 *     tags: [Sessions]
 *     summary: Get a session
 *     operationId: getSession
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Session details
 */
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

/**
 * @openapi
 * /agents/{agentId}/sessions/{sessionId}:
 *   patch:
 *     tags: [Sessions]
 *     summary: Update a session
 *     operationId: updateSession
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateSessionRequest'
 *     responses:
 *       '200':
 *         description: Updated session
 */
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

/**
 * @openapi
 * /agents/{agentId}/sessions/{sessionId}:
 *   delete:
 *     tags: [Sessions]
 *     summary: Delete a session
 *     operationId: deleteSession
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '204':
 *         description: Session deleted
 */
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

/**
 * @openapi
 * /agents/{agentId}/sessions/{sessionId}/messages:
 *   get:
 *     tags: [Sessions]
 *     summary: List messages in a session
 *     operationId: listSessionMessages
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *     responses:
 *       '200':
 *         description: List of messages
 */
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

/**
 * @openapi
 * /agents/{agentId}/sessions/{sessionId}/messages:
 *   post:
 *     tags: [Sessions]
 *     summary: Add a user message to the session (save only, no LLM call)
 *     operationId: addSessionMessage
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AddSessionMessageRequest'
 *     responses:
 *       '201':
 *         description: Message saved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AddSessionMessageResponse'
 */
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

/**
 * @openapi
 * /agents/{agentId}/sessions/{sessionId}/generate:
 *   post:
 *     tags: [Sessions]
 *     summary: Trigger LLM generation for the session
 *     operationId: generateSessionResponse
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: async
 *         required: false
 *         schema:
 *           type: boolean
 *         description: If true, trigger generation asynchronously and return 202 immediately
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/GenerateSessionRequest'
 *     responses:
 *       '200':
 *         description: Generation result (sync)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GenerateSessionResponse'
 *       '202':
 *         description: Generation accepted (async)
 *       '409':
 *         description: Generation already in progress
 */
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

  if (result === 'cancelled_by_newer_request') {
    ctx.status = 409;
    ctx.body = { error: 'Generation was superseded by a concurrent request' };
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

/**
 * @openapi
 * /agents/{agentId}/sessions/{sessionId}/tool-outputs:
 *   post:
 *     tags: [Sessions]
 *     summary: Submit tool outputs for client tools
 *     operationId: submitSessionToolOutputs
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SubmitSessionToolOutputsRequest'
 *     responses:
 *       '200':
 *         description: Generation result
 */
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

/**
 * @openapi
 * /agents/{agentId}/sessions/{sessionId}/tags:
 *   get:
 *     tags: [Sessions]
 *     summary: Get session tags
 *     operationId: getSessionTags
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Session tags
 */
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

/**
 * @openapi
 * /agents/{agentId}/sessions/{sessionId}/tags:
 *   put:
 *     tags: [Sessions]
 *     summary: Replace session tags
 *     operationId: replaceSessionTags
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties:
 *               type: string
 *     responses:
 *       '200':
 *         description: Updated tags
 */
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

/**
 * @openapi
 * /agents/{agentId}/sessions/{sessionId}/tags:
 *   patch:
 *     tags: [Sessions]
 *     summary: Merge session tags
 *     operationId: mergeSessionTags
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties:
 *               type: string
 *     responses:
 *       '200':
 *         description: Updated tags
 */
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
