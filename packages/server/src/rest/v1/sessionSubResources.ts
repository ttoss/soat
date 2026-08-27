import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { forkSession, listSessionForks } from 'src/lib/sessionFork';
import {
  addSessionMessage,
  generateSessionResponse,
  getSessionTags,
  submitSessionToolOutputs,
  updateSessionTags,
} from 'src/lib/sessions';

import { requireProjectAccess } from './helpers';
import { checkSessionAccess } from './sessions';

const sessionSubResourcesRouter = new Router<Context>();

// ── Add Message ──────────────────────────────────────────────────────────

const validateAddMessageBody = (body: {
  message?: string;
  document_id?: string;
}) => {
  if (body.message !== undefined && typeof body.message !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'message must be a string');
  }
  if (body.document_id !== undefined && typeof body.document_id !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'document_id must be a string');
  }
  if (!body.message && !body.document_id) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'either message or document_id is required'
    );
  }
  if (body.message && body.document_id) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'message and document_id are mutually exclusive'
    );
  }
};

sessionSubResourcesRouter.post(
  '/sessions/:session_id/messages',
  async (ctx: Context) => {
    const { agentId } = await checkSessionAccess(
      ctx,
      'agents:SendSessionMessage'
    );

    const body = ctx.request.body as {
      message?: string;
      document_id?: string;
      tool_context?: Record<string, string>;
      idempotency_key?: string;
    };

    validateAddMessageBody(body);

    const result = await addSessionMessage({
      agentId,
      sessionId: ctx.params.session_id,
      message: body.message,
      documentId: body.document_id,
      toolContext: body.tool_context,
      authUser: ctx.authUser,
      idempotencyKey: body.idempotency_key,
    });

    const resultObj = result as Record<string, unknown>;
    const isIdempotentHit = resultObj.idempotent === true;
    ctx.status = isIdempotentHit ? 200 : 201;
    ctx.type = 'application/json';

    const { idempotent: _flag, ...responseBody } = resultObj;
    ctx.body = responseBody;
  }
);

// ── Generate Response ────────────────────────────────────────────────────

sessionSubResourcesRouter.post(
  '/sessions/:session_id/generate',
  async (ctx: Context) => {
    const { agentId } = await checkSessionAccess(
      ctx,
      'agents:SendSessionMessage'
    );

    const body =
      (ctx.request.body as {
        model?: string;
        tool_context?: Record<string, string>;
      }) ?? {};
    // Background by default; ?wait=true blocks until the generation settles.
    const wait = ctx.query['wait'] === 'true';

    if (!wait) {
      generateSessionResponse({
        agentId,
        sessionId: ctx.params.session_id,
        model: body.model,
        toolContext: body.tool_context,
      }).catch(() => {
        // Fire-and-forget: errors are emitted via event bus
      });
      ctx.status = 202;
      ctx.body = { status: 'accepted', session_id: ctx.params.session_id };
      return;
    }

    const result = await generateSessionResponse({
      agentId,
      sessionId: ctx.params.session_id,
      model: body.model,
      toolContext: body.tool_context,
    });

    ctx.body = result;
  }
);

// ── Submit Tool Outputs ──────────────────────────────────────────────────

sessionSubResourcesRouter.post(
  '/sessions/:session_id/tool-outputs',
  async (ctx: Context) => {
    const { agentId, agentPublicId } = await checkSessionAccess(
      ctx,
      'agents:SubmitSessionToolOutputs'
    );

    const body = ctx.request.body as {
      generation_id?: string;
      tool_outputs?: Array<{ tool_call_id: string; output: unknown }>;
    };

    if (!body.generation_id || typeof body.generation_id !== 'string') {
      throw new DomainError('VALIDATION_FAILED', 'generationId is required');
    }

    if (!Array.isArray(body.tool_outputs) || body.tool_outputs.length === 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'tool_outputs is required and must be a non-empty array'
      );
    }

    const result = await submitSessionToolOutputs({
      agentId,
      agentPublicId,
      sessionId: ctx.params.session_id,
      generationId: body.generation_id,
      toolOutputs: body.tool_outputs.map((toolOutput) => {
        return {
          toolCallId: toolOutput.tool_call_id,
          output: toolOutput.output,
        };
      }),
    });

    ctx.body = result;
  }
);

// ── Fork ─────────────────────────────────────────────────────────────────

/**
 * @openapi
 * POST /api/v1/sessions/{session_id}/fork
 * operationId: forkSession
 * Branches a new session from a point in this session's history. The fork's
 * messages reference the parent's documents rather than copying them, and the
 * fork is created inert — no generation is triggered.
 */
sessionSubResourcesRouter.post(
  '/sessions/:session_id/fork',
  async (ctx: Context) => {
    // Forking reads a session's full history as well as creating one, so
    // `agents:CreateSession` alone would be a way to read history a principal
    // cannot fetch through `GET /sessions/{id}`.
    const { agentId } = await checkSessionAccess(ctx, 'agents:GetSession');
    await requireProjectAccess({
      ctx,
      action: 'agents:CreateSession',
      resourceType: 'session',
    });

    const body = ctx.request.body as {
      fork_at_position?: number;
      agent_id?: string;
      name?: string;
      tags?: Record<string, string>;
      tool_context?: Record<string, string> | null;
    };

    ctx.status = 201;
    ctx.body = await forkSession({
      agentId,
      sessionId: ctx.params.session_id,
      forkAtPosition: body.fork_at_position,
      agentPublicId: body.agent_id,
      name: body.name,
      tags: body.tags,
      toolContext: body.tool_context,
    });
  }
);

/**
 * @openapi
 * GET /api/v1/sessions/{session_id}/forks
 * operationId: listSessionForks
 * Lists the sessions forked directly from this one. One level of lineage —
 * a fork of a fork is listed under its own parent, not here.
 */
sessionSubResourcesRouter.get(
  '/sessions/:session_id/forks',
  async (ctx: Context) => {
    const { agentId } = await checkSessionAccess(ctx, 'agents:GetSession');

    const { limit, offset } = ctx.query as Record<string, string | undefined>;

    ctx.body = await listSessionForks({
      agentId,
      sessionId: ctx.params.session_id,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }
);

// ── Tags ─────────────────────────────────────────────────────────────────

sessionSubResourcesRouter.get(
  '/sessions/:session_id/tags',
  async (ctx: Context) => {
    const { agentId } = await checkSessionAccess(ctx, 'agents:GetSession');

    ctx.body = await getSessionTags({
      agentId,
      sessionId: ctx.params.session_id,
    });
  }
);

sessionSubResourcesRouter.put(
  '/sessions/:session_id/tags',
  async (ctx: Context) => {
    const { agentId } = await checkSessionAccess(ctx, 'agents:UpdateSession');

    const tags = ctx.request.body as Record<string, string>;

    ctx.body = await updateSessionTags({
      agentId,
      sessionId: ctx.params.session_id,
      tags,
      merge: false,
    });
  }
);

sessionSubResourcesRouter.patch(
  '/sessions/:session_id/tags',
  async (ctx: Context) => {
    const { agentId } = await checkSessionAccess(ctx, 'agents:UpdateSession');

    const tags = ctx.request.body as Record<string, string>;

    ctx.body = await updateSessionTags({
      agentId,
      sessionId: ctx.params.session_id,
      tags,
      merge: true,
    });
  }
);

export { sessionSubResourcesRouter };
