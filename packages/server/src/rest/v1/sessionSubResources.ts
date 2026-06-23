import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  addSessionMessage,
  generateSessionResponse,
  getSessionTags,
  submitSessionToolOutputs,
  updateSessionTags,
} from 'src/lib/sessions';

import { checkSessionAccess } from './sessions';

const sessionSubResourcesRouter = new Router<Context>();

// ── Add Message ──────────────────────────────────────────────────────────

const validateAddMessageBody = (body: {
  message?: string;
  documentId?: string;
}) => {
  if (body.message !== undefined && typeof body.message !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'message must be a string');
  }
  if (body.documentId !== undefined && typeof body.documentId !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'documentId must be a string');
  }
  if (!body.message && !body.documentId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'either message or documentId is required'
    );
  }
  if (body.message && body.documentId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'message and documentId are mutually exclusive'
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
      documentId?: string;
      toolContext?: Record<string, string>;
      idempotencyKey?: string;
    };

    validateAddMessageBody(body);

    const result = await addSessionMessage({
      agentId,
      sessionId: ctx.params.session_id,
      message: body.message,
      documentId: body.documentId,
      toolContext: body.toolContext,
      authUser: ctx.authUser,
      idempotencyKey: body.idempotencyKey,
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
        toolContext?: Record<string, string>;
      }) ?? {};
    const isAsync = ctx.query['async'] === 'true';

    if (isAsync) {
      generateSessionResponse({
        agentId,
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
      agentId,
      sessionId: ctx.params.session_id,
      model: body.model,
      toolContext: body.toolContext,
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
      agentId,
      agentPublicId,
      sessionId: ctx.params.session_id,
      generationId: body.generationId,
      toolOutputs: body.toolOutputs,
    });

    ctx.body = result;
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
