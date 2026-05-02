import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  addSessionMessage,
  generateSessionResponse,
  getSessionTags,
  listSessionMessages,
  submitSessionToolOutputs,
  updateSessionTags,
} from 'src/lib/sessions';

const resolveAgent = async (agentPublicId: string) => {
  return db.Agent.findOne({ where: { publicId: agentPublicId } });
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
  const agent = await resolveAgent(ctx.params.agent_id);
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

const sessionSubResourcesRouter = new Router<Context>();

sessionSubResourcesRouter.get('/:session_id/messages', async (ctx: Context) => {
  const agentAccess = await checkAgentAccess(ctx, 'agents:GetSession');
  if (!agentAccess) return;
  const { agent } = agentAccess;

  const { limit, offset } = ctx.query as Record<string, string | undefined>;

  const result = await listSessionMessages({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
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

sessionSubResourcesRouter.post(
  '/:session_id/messages',
  async (ctx: Context) => {
    const agentAccess = await checkAgentAccess(
      ctx,
      'agents:SendSessionMessage'
    );
    if (!agentAccess) return;
    const { agent } = agentAccess;

    const body = ctx.request.body as {
      message?: string;
      toolContext?: Record<string, string>;
    };

    if (!body.message || typeof body.message !== 'string') {
      ctx.status = 400;
      ctx.body = { error: 'message is required' };
      return;
    }

    try {
      const result = await addSessionMessage({
        agentId: agent.id as number,
        sessionId: ctx.params.session_id,
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
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error adding session message:', error);
      ctx.status = 500;
      ctx.body = { error: 'Error adding session message' };
    }
  }
);

// ── Generate Response ────────────────────────────────────────────────────

sessionSubResourcesRouter.post(
  '/:session_id/generate',
  async (ctx: Context) => {
    const agentAccess = await checkAgentAccess(
      ctx,
      'agents:SendSessionMessage'
    );
    if (!agentAccess) return;
    const { agent } = agentAccess;

    const body =
      (ctx.request.body as {
        model?: string;
        toolContext?: Record<string, string>;
      }) ?? {};
    const isAsync = ctx.query['async'] === 'true';

    if (isAsync) {
      generateSessionResponse({
        agentId: agent.id as number,
        sessionId: ctx.params.session_id,
        model: body.model,
        toolContext: body.toolContext,
      }).catch(() => {
        // Fire-and-forget: errors are emitted via event bus
      });
      ctx.status = 202;
      ctx.body = { status: 'accepted', sessionId: ctx.params.session_id };
      return;
    }

    try {
      const result = await generateSessionResponse({
        agentId: agent.id as number,
        sessionId: ctx.params.session_id,
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
        // eslint-disable-next-line no-console
        console.error('Error generating session response:', result);
        ctx.status = 500;
        ctx.body = { error: 'Error generating session response' };
        return;
      }

      ctx.body = result;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error generating session response:', error);
      ctx.status = 500;
      ctx.body = { error: 'Error generating session response' };
    }
  }
);

// ── Submit Tool Outputs ──────────────────────────────────────────────────

sessionSubResourcesRouter.post(
  '/:session_id/tool-outputs',
  async (ctx: Context) => {
    const agentAccess = await checkAgentAccess(
      ctx,
      'agents:SubmitSessionToolOutputs'
    );
    if (!agentAccess) return;
    const { agent } = agentAccess;

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
      agentPublicId: ctx.params.agent_id,
      sessionId: ctx.params.session_id,
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
  }
);

// ── Tags ─────────────────────────────────────────────────────────────────

sessionSubResourcesRouter.get('/:session_id/tags', async (ctx: Context) => {
  const agentAccess = await checkAgentAccess(ctx, 'agents:GetSession');
  if (!agentAccess) return;
  const { agent } = agentAccess;

  const result = await getSessionTags({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
  });

  if (result === null) {
    ctx.status = 404;
    ctx.body = { error: 'Session not found' };
    return;
  }

  ctx.body = result;
});

sessionSubResourcesRouter.put('/:session_id/tags', async (ctx: Context) => {
  const agentAccess = await checkAgentAccess(ctx, 'agents:UpdateSession');
  if (!agentAccess) return;
  const { agent } = agentAccess;

  const tags = ctx.request.body as Record<string, string>;

  const result = await updateSessionTags({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
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

sessionSubResourcesRouter.patch('/:session_id/tags', async (ctx: Context) => {
  const agentAccess = await checkAgentAccess(ctx, 'agents:UpdateSession');
  if (!agentAccess) return;
  const { agent } = agentAccess;

  const tags = ctx.request.body as Record<string, string>;

  const result = await updateSessionTags({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
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

export { sessionSubResourcesRouter };
