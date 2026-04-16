import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createAgent,
  createAgentTool,
  createGeneration,
  deleteAgent,
  deleteAgentTool,
  getAgent,
  getAgentTool,
  getTrace,
  listAgents,
  listAgentTools,
  listTraces,
  submitToolOutputs,
  updateAgent,
  updateAgentTool,
} from 'src/lib/agents';

export const agentsRouter = new Router<Context>();

// ── Agent Tools (must be mounted before /agents/:agentId) ────────────────

/**
 * @openapi
 * /agents/tools:
 *   post:
 *     tags:
 *       - Agent Tools
 *     summary: Create an agent tool
 *     description: Creates a new agent tool in the project.
 *     operationId: createAgentTool
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAgentToolRequest'
 *     responses:
 *       '201':
 *         description: Agent tool created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentTool'
 *       '400':
 *         description: Bad Request
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 */
agentsRouter.post('/agents/tools', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const {
    name,
    type,
    description,
    parameters,
    execute,
    mcp,
    actions,
    projectId: projectPublicId,
  } = ctx.request.body as {
    name?: unknown;
    type?: unknown;
    description?: unknown;
    parameters?: unknown;
    execute?: unknown;
    mcp?: unknown;
    actions?: unknown;
    projectId?: string;
  };

  if (!name || typeof name !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'agents:CreateAgentTool',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const targetProjectId = projectIds?.[0] ?? ctx.authUser.projectKeyProjectId;

  if (!targetProjectId) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return;
  }

  const result = await createAgentTool({
    projectId: Number(targetProjectId),
    name,
    type: typeof type === 'string' ? type : undefined,
    description: typeof description === 'string' ? description : undefined,
    parameters: parameters as object | undefined,
    execute: execute as object | undefined,
    mcp: mcp as object | undefined,
    actions: Array.isArray(actions) ? actions : undefined,
  });

  ctx.status = 201;
  ctx.body = result;
});

/**
 * @openapi
 * /agents/tools:
 *   get:
 *     tags:
 *       - Agent Tools
 *     summary: List agent tools
 *     description: Returns all agent tools in the project.
 *     operationId: listAgentTools
 *     parameters:
 *       - name: projectId
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: List of agent tools
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AgentTool'
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 */
agentsRouter.get('/agents/tools', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'agents:ListAgentTools',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listAgentTools({ projectIds });
});

/**
 * @openapi
 * /agents/tools/{toolId}:
 *   get:
 *     tags:
 *       - Agent Tools
 *     summary: Get an agent tool
 *     description: Returns a single agent tool by ID.
 *     operationId: getAgentTool
 *     parameters:
 *       - name: toolId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Agent tool
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentTool'
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 */
agentsRouter.get('/agents/tools/:toolId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:GetAgentTool',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await getAgentTool({
    projectIds,
    id: ctx.params.toolId,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent tool not found' };
    return;
  }

  ctx.body = result;
});

/**
 * @openapi
 * /agents/tools/{toolId}:
 *   put:
 *     tags:
 *       - Agent Tools
 *     summary: Update an agent tool
 *     description: Updates an existing agent tool.
 *     operationId: updateAgentTool
 *     parameters:
 *       - name: toolId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateAgentToolRequest'
 *     responses:
 *       '200':
 *         description: Agent tool updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentTool'
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 */
agentsRouter.put('/agents/tools/:toolId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:UpdateAgentTool',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { name, type, description, parameters, execute, mcp, actions } = ctx
    .request.body as Record<string, unknown>;

  const result = await updateAgentTool({
    projectIds,
    id: ctx.params.toolId,
    name: typeof name === 'string' ? name : undefined,
    type: typeof type === 'string' ? type : undefined,
    description:
      description === null
        ? null
        : typeof description === 'string'
          ? description
          : undefined,
    parameters:
      parameters !== undefined ? (parameters as object | null) : undefined,
    execute: execute !== undefined ? (execute as object | null) : undefined,
    mcp: mcp !== undefined ? (mcp as object | null) : undefined,
    actions: actions !== undefined ? (actions as string[] | null) : undefined,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent tool not found' };
    return;
  }

  ctx.body = result;
});

/**
 * @openapi
 * /agents/tools/{toolId}:
 *   delete:
 *     tags:
 *       - Agent Tools
 *     summary: Delete an agent tool
 *     description: Deletes an agent tool by ID.
 *     operationId: deleteAgentTool
 *     parameters:
 *       - name: toolId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '204':
 *         description: Deleted
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 */
agentsRouter.delete('/agents/tools/:toolId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:DeleteAgentTool',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await deleteAgentTool({
    projectIds,
    id: ctx.params.toolId,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent tool not found' };
    return;
  }

  ctx.status = 204;
});

// ── Traces (must be mounted before /agents/:agentId) ─────────────────────

/**
 * @openapi
 * /agents/traces:
 *   get:
 *     tags:
 *       - Agent Traces
 *     summary: List agent traces
 *     description: Returns all traces for the project.
 *     operationId: listAgentTraces
 *     parameters:
 *       - name: projectId
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: List of traces
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 */
agentsRouter.get('/agents/traces', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'agents:ListAgentTraces',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listTraces({ projectIds });
});

/**
 * @openapi
 * /agents/traces/{traceId}:
 *   get:
 *     tags:
 *       - Agent Traces
 *     summary: Get a trace
 *     description: Returns a single trace by ID.
 *     operationId: getAgentTrace
 *     parameters:
 *       - name: traceId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Trace details
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 */
agentsRouter.get('/agents/traces/:traceId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:GetAgentTrace',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await getTrace({
    projectIds,
    traceId: ctx.params.traceId,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Trace not found' };
    return;
  }

  ctx.body = result;
});

// ── Agents CRUD ──────────────────────────────────────────────────────────

/**
 * @openapi
 * /agents:
 *   post:
 *     tags:
 *       - Agents
 *     summary: Create an agent
 *     description: Creates a new agent bound to an AI provider.
 *     operationId: createAgent
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAgentRequest'
 *     responses:
 *       '201':
 *         description: Agent created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Agent'
 *       '400':
 *         description: Bad Request
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: AI provider not found
 */
agentsRouter.post('/agents', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const {
    aiProviderId,
    name,
    instructions,
    model,
    toolIds,
    maxSteps,
    toolChoice,
    stopConditions,
    activeToolIds,
    stepRules,
    boundaryPolicy,
    temperature,
    projectId: projectPublicId,
  } = ctx.request.body as {
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
    projectId?: string;
  };

  if (!aiProviderId || typeof aiProviderId !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'aiProviderId is required' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'agents:CreateAgent',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const targetProjectId = projectIds?.[0] ?? ctx.authUser.projectKeyProjectId;

  if (!targetProjectId) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return;
  }

  const result = await createAgent({
    projectId: Number(targetProjectId),
    aiProviderId,
    name: typeof name === 'string' ? name : undefined,
    instructions: typeof instructions === 'string' ? instructions : undefined,
    model: typeof model === 'string' ? model : undefined,
    toolIds: Array.isArray(toolIds) ? toolIds : undefined,
    maxSteps: typeof maxSteps === 'number' ? maxSteps : undefined,
    toolChoice: toolChoice as object | undefined,
    stopConditions: Array.isArray(stopConditions) ? stopConditions : undefined,
    activeToolIds: Array.isArray(activeToolIds) ? activeToolIds : undefined,
    stepRules: Array.isArray(stepRules) ? stepRules : undefined,
    boundaryPolicy: boundaryPolicy as object | undefined,
    temperature: typeof temperature === 'number' ? temperature : undefined,
  });

  if (result === 'ai_provider_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'AI provider not found' };
    return;
  }

  ctx.status = 201;
  ctx.body = result;
});

/**
 * @openapi
 * /agents:
 *   get:
 *     tags:
 *       - Agents
 *     summary: List agents
 *     description: Returns all agents in the project.
 *     operationId: listAgents
 *     parameters:
 *       - name: projectId
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: List of agents
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Agent'
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 */
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

/**
 * @openapi
 * /agents/{agentId}:
 *   get:
 *     tags:
 *       - Agents
 *     summary: Get an agent
 *     description: Returns a single agent by ID.
 *     operationId: getAgent
 *     parameters:
 *       - name: agentId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Agent details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Agent'
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 */
agentsRouter.get('/agents/:agentId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:GetAgent',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await getAgent({
    projectIds,
    id: ctx.params.agentId,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found' };
    return;
  }

  ctx.body = result;
});

/**
 * @openapi
 * /agents/{agentId}:
 *   put:
 *     tags:
 *       - Agents
 *     summary: Update an agent
 *     description: Updates an existing agent.
 *     operationId: updateAgent
 *     parameters:
 *       - name: agentId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateAgentRequest'
 *     responses:
 *       '200':
 *         description: Agent updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Agent'
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 */
agentsRouter.put('/agents/:agentId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:UpdateAgent',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as Record<string, unknown>;

  const result = await updateAgent({
    projectIds,
    id: ctx.params.agentId,
    aiProviderId:
      typeof body.aiProviderId === 'string' ? body.aiProviderId : undefined,
    name:
      body.name === null
        ? null
        : typeof body.name === 'string'
          ? body.name
          : undefined,
    instructions:
      body.instructions === null
        ? null
        : typeof body.instructions === 'string'
          ? body.instructions
          : undefined,
    model:
      body.model === null
        ? null
        : typeof body.model === 'string'
          ? body.model
          : undefined,
    toolIds:
      body.toolIds !== undefined
        ? (body.toolIds as string[] | null)
        : undefined,
    maxSteps:
      body.maxSteps !== undefined
        ? (body.maxSteps as number | null)
        : undefined,
    toolChoice:
      body.toolChoice !== undefined
        ? (body.toolChoice as object | null)
        : undefined,
    stopConditions:
      body.stopConditions !== undefined
        ? (body.stopConditions as object[] | null)
        : undefined,
    activeToolIds:
      body.activeToolIds !== undefined
        ? (body.activeToolIds as string[] | null)
        : undefined,
    stepRules:
      body.stepRules !== undefined
        ? (body.stepRules as object[] | null)
        : undefined,
    boundaryPolicy:
      body.boundaryPolicy !== undefined
        ? (body.boundaryPolicy as object | null)
        : undefined,
    temperature:
      body.temperature !== undefined
        ? (body.temperature as number | null)
        : undefined,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found' };
    return;
  }

  if (result === 'ai_provider_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'AI provider not found' };
    return;
  }

  ctx.body = result;
});

/**
 * @openapi
 * /agents/{agentId}:
 *   delete:
 *     tags:
 *       - Agents
 *     summary: Delete an agent
 *     description: Deletes an agent by ID.
 *     operationId: deleteAgent
 *     parameters:
 *       - name: agentId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '204':
 *         description: Deleted
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 */
agentsRouter.delete('/agents/:agentId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:DeleteAgent',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await deleteAgent({
    projectIds,
    id: ctx.params.agentId,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found' };
    return;
  }

  ctx.status = 204;
});

// ── Generation ───────────────────────────────────────────────────────────

/**
 * @openapi
 * /agents/{agentId}/generate:
 *   post:
 *     tags:
 *       - Agents
 *     summary: Run an agent generation
 *     description: >
 *       Sends messages to the agent, resolves its tools, and runs the AI model
 *       loop. Supports streaming via `stream: true`. Client tools pause the
 *       generation and return `requires_action`.
 *     operationId: createAgentGeneration
 *     parameters:
 *       - name: agentId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAgentGenerationRequest'
 *     responses:
 *       '200':
 *         description: Generation result or SSE stream
 *       '400':
 *         description: Bad Request
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Agent or AI provider not found
 */
agentsRouter.post('/agents/:agentId/generate', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:CreateAgentGeneration',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { messages, stream, traceId } = ctx.request.body as {
    messages?: unknown;
    stream?: boolean;
    traceId?: string;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'messages is required and must be a non-empty array' };
    return;
  }

  const result = await createGeneration({
    projectIds,
    agentId: ctx.params.agentId,
    messages: messages as Array<{ role: string; content: string }>,
    stream: stream === true,
    traceId,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent not found' };
    return;
  }

  if (result === 'ai_provider_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'AI provider not found' };
    return;
  }

  // Streaming response
  if (stream && result && typeof result === 'object' && 'getReader' in result) {
    ctx.respond = false;
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      const readableStream = result as ReadableStream;
      const reader = readableStream.getReader();
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        if (chunk.value) {
          ctx.res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: chunk.value } }] })}\n\n`
          );
        }
      }
      ctx.res.write('data: [DONE]\n\n');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Internal server error';
      ctx.res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    } finally {
      ctx.res.end();
    }

    return;
  }

  ctx.body = result;
});

/**
 * @openapi
 * /agents/{agentId}/generate/{generationId}/tool-outputs:
 *   post:
 *     tags:
 *       - Agents
 *     summary: Submit tool outputs for a paused generation
 *     description: >
 *       Resumes a generation that was paused due to client tool calls.
 *       Provide tool outputs for each pending tool call.
 *     operationId: submitAgentToolOutputs
 *     parameters:
 *       - name: agentId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: generationId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SubmitToolOutputsRequest'
 *     responses:
 *       '200':
 *         description: Generation result after resuming
 *       '400':
 *         description: Bad Request
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Agent or generation not found
 */
agentsRouter.post(
  '/agents/:agentId/generate/:generationId/tool-outputs',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const projectIds = await ctx.authUser.resolveProjectIds({
      action: 'agents:CreateAgentGeneration',
    });

    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const { toolOutputs } = ctx.request.body as {
      toolOutputs?: unknown;
    };

    if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) {
      ctx.status = 400;
      ctx.body = {
        error: 'toolOutputs is required and must be a non-empty array',
      };
      return;
    }

    const result = await submitToolOutputs({
      projectIds,
      agentId: ctx.params.agentId,
      generationId: ctx.params.generationId,
      toolOutputs: toolOutputs as Array<{
        toolCallId: string;
        output: unknown;
      }>,
    });

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
  }
);
