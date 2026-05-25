import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
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

const sessionSubResourcesRouter = new Router<Context>();

sessionSubResourcesRouter.get('/:session_id/messages', async (ctx: Context) => {
  const { agent } = await checkAgentAccess(ctx, 'agents:GetSession');

  const { limit, offset } = ctx.query as Record<string, string | undefined>;

  const result = await listSessionMessages({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });

  ctx.body = result;
});

// ── Add Message ──────────────────────────────────────────────────────────

sessionSubResourcesRouter.post(
  '/:session_id/messages',
  async (ctx: Context) => {
    const { agent } = await checkAgentAccess(ctx, 'agents:SendSessionMessage');

    const body = ctx.request.body as {
      message?: string;
      toolContext?: Record<string, string>;
    };

    if (!body.message || typeof body.message !== 'string') {
      throw new DomainError('VALIDATION_FAILED', 'message is required');
    }

    const result = await addSessionMessage({
      agentId: agent.id as number,
      sessionId: ctx.params.session_id,
      message: body.message,
      toolContext: body.toolContext,
    });

    ctx.status = 201;
    ctx.body = result;
  }
);

// ── Generate Response ────────────────────────────────────────────────────

sessionSubResourcesRouter.post(
  '/:session_id/generate',
  async (ctx: Context) => {
    const { agent } = await checkAgentAccess(ctx, 'agents:SendSessionMessage');

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

    const result = await generateSessionResponse({
      agentId: agent.id as number,
      sessionId: ctx.params.session_id,
      model: body.model,
      toolContext: body.toolContext,
    });

    ctx.body = result;
  }
);

// ── Submit Tool Outputs ──────────────────────────────────────────────────

sessionSubResourcesRouter.post(
  '/:session_id/tool-outputs',
  async (ctx: Context) => {
    const { agent } = await checkAgentAccess(
      ctx,
      'agents:SubmitSessionToolOutputs'
    );

    const body = ctx.request.body as {
      generationId?: string;
      toolOutputs?: Array<{ toolCallId: string; output: unknown }>;
    };

    if (!body.generationId || typeof body.generationId !== 'string') {
      throw new DomainError('VALIDATION_FAILED', 'generationId is required');
    }

    if (!Array.isArray(body.toolOutputs) || body.toolOutputs.length === 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'toolOutputs is required and must be a non-empty array'
      );
    }

    const result = await submitSessionToolOutputs({
      agentId: agent.id as number,
      agentPublicId: ctx.params.agent_id,
      sessionId: ctx.params.session_id,
      generationId: body.generationId,
      toolOutputs: body.toolOutputs,
    });

    ctx.body = result;
  }
);

// ── Tags ─────────────────────────────────────────────────────────────────

sessionSubResourcesRouter.get('/:session_id/tags', async (ctx: Context) => {
  const { agent } = await checkAgentAccess(ctx, 'agents:GetSession');

  const result = await getSessionTags({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
  });

  ctx.body = result;
});

sessionSubResourcesRouter.put('/:session_id/tags', async (ctx: Context) => {
  const { agent } = await checkAgentAccess(ctx, 'agents:UpdateSession');

  const tags = ctx.request.body as Record<string, string>;

  const result = await updateSessionTags({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
    tags,
    merge: false,
  });

  ctx.body = result;
});

sessionSubResourcesRouter.patch('/:session_id/tags', async (ctx: Context) => {
  const { agent } = await checkAgentAccess(ctx, 'agents:UpdateSession');

  const tags = ctx.request.body as Record<string, string>;

  const result = await updateSessionTags({
    agentId: agent.id as number,
    sessionId: ctx.params.session_id,
    tags,
    merge: true,
  });

  ctx.body = result;
});

export { sessionSubResourcesRouter };
