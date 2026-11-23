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
import { assertNoSystemTagKeys } from 'src/lib/tags';
import { captureAuthority } from 'src/lib/workAuthority';

import { authorizeGenerationResume } from './generations';
import { resolveStreamWait, respondAcceptedTurn } from './generationStream';
import {
  type AuthenticatedContext,
  parseNullableToolContextBody,
  parsePagination,
  parseToolContextBody,
} from './helpers';
import { idempotencyKeyOf } from './idempotencyKey';
import { checkSessionAccess } from './sessions';
import {
  declareBodyTags,
  registerTagRoutes,
  type TagAccess,
} from './tagRoutes';

const sessionSubResourcesRouter = new Router<Context>();

// ── Add Message ──────────────────────────────────────────────────────────

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
      file_ids?: string[];
      tool_context?: unknown;
    };

    const result = await addSessionMessage({
      agentId,
      sessionId: ctx.params.session_id,
      message: body.message,
      documentId: body.document_id,
      fileIds: body.file_ids,
      toolContext: parseToolContextBody({
        raw: body.tool_context,
        reservedPrefix: 'refuse',
      }),
      authUser: ctx.authUser,
      authority: captureAuthority({ authUser: ctx.authUser }),
      idempotencyKey: idempotencyKeyOf(ctx),
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
        stream?: boolean;
        tool_context?: unknown;
      }) ?? {};
    const stream = body.stream === true;
    const wait = resolveStreamWait({ ctx, stream });

    const turn = {
      agentId,
      sessionId: ctx.params.session_id,
      model: body.model,
      toolContext: parseToolContextBody({
        raw: body.tool_context,
        reservedPrefix: 'refuse',
      }),
      authority: captureAuthority({ authUser: ctx.authUser }),
      authUser: ctx.authUser,
    };

    if (stream || !wait) {
      await respondAcceptedTurn({
        ctx,
        stream,
        handle: { session_id: ctx.params.session_id },
        label: 'session generate stream',
        start: async (onRecorded) => {
          const result = await generateSessionResponse({ ...turn, onRecorded });
          return {
            generationId: result.generation_id,
            traceId: result.trace_id,
          };
        },
      });
      return;
    }

    const result = await generateSessionResponse(turn);

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

    await authorizeGenerationResume({ ctx, generationId: body.generation_id });

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
      authority: captureAuthority({ authUser: ctx.authUser }),
      authUser: ctx.authUser,
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
    declareBodyTags(ctx);
    // Forking reads a session's full history as well as creating one, so
    // `agents:CreateSession` alone would be a way to read history a principal
    // cannot fetch through `GET /sessions/{id}`. Both halves name the *parent*
    // session's SRN — the fork's own id does not exist yet, and the parent is
    // the resource whose history the call reaches.
    const { agentId } = await checkSessionAccess(ctx, 'agents:GetSession');
    await checkSessionAccess(ctx, 'agents:CreateSession');

    const body = ctx.request.body as {
      fork_at_position?: number;
      agent_id?: string;
      name?: string;
      tags?: Record<string, string>;
      tool_context?: unknown;
    };

    ctx.status = 201;
    ctx.body = await forkSession({
      agentId,
      sessionId: ctx.params.session_id,
      forkAtPosition: body.fork_at_position,
      agentPublicId: body.agent_id,
      name: body.name,
      tags: assertNoSystemTagKeys(body.tags),
      toolContext: parseNullableToolContextBody({
        raw: body.tool_context,
        reservedPrefix: 'refuse',
      }),
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

    ctx.body = await listSessionForks({
      agentId,
      sessionId: ctx.params.session_id,
      ...parsePagination(ctx),
    });
  }
);

// ── Tags ─────────────────────────────────────────────────────────────────

const resolveSession = async (args: {
  ctx: AuthenticatedContext;
  access: TagAccess;
}) => {
  const { agentId } = await checkSessionAccess(
    args.ctx,
    args.access === 'read' ? 'agents:GetSession' : 'agents:UpdateSession'
  );
  return { agentId, sessionId: args.ctx.params.session_id };
};

registerTagRoutes({
  router: sessionSubResourcesRouter,
  path: '/sessions/:session_id/tags',
  resolve: resolveSession,
  readTags: ({ resource }) => {
    return getSessionTags(resource);
  },
  writeTags: ({ resource, tags, merge }) => {
    return updateSessionTags({ ...resource, tags, merge });
  },
});

export { sessionSubResourcesRouter };
