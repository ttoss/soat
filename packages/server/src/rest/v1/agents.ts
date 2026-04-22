import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { createActor } from 'src/lib/actors';
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
import { sessionsRouter } from './sessions';

export const agentsRouter = new Router<Context>();

// ── Sessions (sub-resource) ──────────────────────────────────────────────

agentsRouter.use(
  '/agents/:agentId/sessions',
  sessionsRouter.routes(),
  sessionsRouter.allowedMethods()
);

// ── Agent Tools (must be mounted before /agents/:agentId) ────────────────

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

  const { messages, stream, traceId, maxCallDepth } = ctx.request.body as {
    messages?: unknown;
    stream?: boolean;
    traceId?: string;
    maxCallDepth?: unknown;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'messages is required and must be a non-empty array' };
    return;
  }

  let result;
  try {
    result = await createGeneration({
      projectIds,
      agentId: ctx.params.agentId,
      messages: messages as Array<{ role: string; content: string }>,
      stream: stream === true,
      traceId,
      remainingDepth:
        typeof maxCallDepth === 'number' ? maxCallDepth : undefined,
      authHeader: (ctx.headers.authorization as string) ?? '',
    });
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      error: error instanceof Error ? error.message : 'Generation failed',
    };
    return;
  }

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

agentsRouter.post('/agents/:agentId/actors', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const agent = await db.Agent.findOne({
    where: { publicId: ctx.params.agentId },
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
    type: body.type,
    externalId: body.externalId,
    instructions: body.instructions ?? null,
    agentId: agent.id as number,
  });

  if (actor === 'agent_and_chat_exclusive') {
    ctx.status = 400;
    ctx.body = { error: 'agentId and chatId are mutually exclusive' };
    return;
  }

  ctx.status = 201;
  ctx.body = actor;
});
