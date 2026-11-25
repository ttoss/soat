import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { purgeGenerationContent } from 'src/lib/contentPurge';
import { listGenerationEvents } from 'src/lib/generationEventFeed';
import { getGenerationMemoryAssertions } from 'src/lib/generationMemoryAssertions';
import {
  GENERATION_STATUSES,
  generations,
  getGeneration,
  listGenerations,
  updateGenerationMetadata,
} from 'src/lib/generations';
import { getGenerationTranscript } from 'src/lib/generationTranscript';
import { validateMetadataBag } from 'src/lib/metadataBag';
import { readsShowing } from 'src/lib/permissionCatalog';

import {
  authorizeGenerationContent,
  serveGenerationEvents,
} from './generationStream';
import {
  parseEnumListQuery,
  parsePagination,
  requestPrincipalFromCtx,
  requireAuth,
  requireFound,
} from './helpers';
import { resolveListScope } from './listScope';
import { authorizeResource, makeItemRouteAuthorizer } from './resourceAccess';

export const generationsRouter = new Router<Context>();

/**
 * Every `/generations/:generation_id` route authorizes against the generation's
 * own SRN rather than the project wildcard a statement naming one generation can
 * never match.
 */
const generationAccess = makeItemRouteAuthorizer({
  findScope: generations.findScope,
  resourceType: 'generation',
  shownBy: readsShowing({ module: 'generations', noun: 'Generation' }),
  param: 'generation_id',
  label: 'Generation',
});

/**
 * Resuming a paused generation needs `generations:ResumeGeneration` on the
 * generation itself, beside whatever the entry point's own resource asks: a
 * caller who may run the agent may not resume every turn of it.
 */
export const authorizeGenerationResume = async (args: {
  ctx: Context;
  generationId: string;
}): Promise<void> => {
  await authorizeResource({
    ctx: args.ctx,
    scope: await generations.findScope({ id: args.generationId }),
    resourceType: 'generation',
    shownBy: readsShowing({ module: 'generations', noun: 'Generation' }),
    resourceId: args.generationId,
    label: 'Generation',
    errorCode: 'GENERATION_NOT_FOUND',
    action: 'generations:ResumeGeneration',
    onDenied: 'refuse',
  });
};

/**
 * @openapi
 * GET /api/v1/generations
 * operationId: listGenerations
 * Lists generations the caller can access, optionally filtered by agent_id,
 * trace_id, session_id, actor_id, chain_id, orchestration_run_id, node_id, and
 * status. An id naming nothing in scope yields an empty page.
 */
generationsRouter.get('/generations', async (ctx: Context) => {
  requireAuth(ctx);

  const { projectIds } = await resolveListScope({
    ctx,
    action: 'generations:ListGenerations',
    resourceType: 'generation',
    projectSelector: 'none',
  });

  const {
    agent_id: agentId,
    trace_id: traceId,
    session_id: sessionId,
    actor_id: actorId,
    initiator_generation_id: initiatorGenerationId,
    chain_id: chainId,
    orchestration_run_id: orchestrationRunId,
    node_id: nodeId,
  } = ctx.query as Record<string, string | undefined>;

  const result = await listGenerations({
    projectIds,
    agentId,
    traceId,
    sessionId,
    actorId,
    initiatorGenerationId,
    chainId,
    orchestrationRunId,
    nodeId,
    statuses: parseEnumListQuery({
      ctx,
      name: 'status',
      allowed: GENERATION_STATUSES,
    }),
    ...parsePagination(ctx),
  });

  ctx.body = result;
});

/**
 * @openapi
 * GET /api/v1/generations/{generation_id}
 * operationId: getGeneration
 * Returns a single generation record by public ID, including its status
 * ('running', 'requires_action', 'completed', or 'failed') and the
 * structured error payload when the generation failed.
 */
generationsRouter.get('/generations/:generation_id', async (ctx: Context) => {
  const { projectIds } = await generationAccess.authorizeRead({
    ctx,
    action: 'generations:GetGeneration',
  });

  ctx.body = requireFound({
    label: 'Generation',
    id: ctx.params.generation_id,
    value: await getGeneration({
      publicId: ctx.params.generation_id,
      projectIds,
      includeUsage: true,
    }),
  });
});

/**
 * @openapi
 * GET /api/v1/generations/{generation_id}/memory-assertions
 * operationId: listGenerationMemoryAssertions
 */
generationsRouter.get(
  '/generations/:generation_id/memory-assertions',
  async (ctx: Context) => {
    const { projectIds } = await generationAccess.authorizeRead({
      ctx,
      action: 'generations:GetGeneration',
    });

    ctx.body = await getGenerationMemoryAssertions({
      publicId: ctx.params.generation_id,
      projectIds,
      ...parsePagination(ctx),
    });
  }
);

/**
 * @openapi
 * GET /api/v1/generations/{generation_id}/transcript
 * operationId: getGenerationTranscript
 * Returns one generation's turn as an ordered transcript: what it was asked,
 * each model step with its tool calls and results, and how it ended. Assembled
 * at read time from the generation row and the trace's steps object — nothing
 * is stored, so a transcript cannot outlive the content it projects.
 */
generationsRouter.get(
  '/generations/:generation_id/transcript',
  async (ctx: Context) => {
    const { projectIds } = await generationAccess.authorizeRead({
      ctx,
      action: 'generations:GetGeneration',
    });

    // The response merges generation columns with the trace's steps, so the
    // caller must be allowed to read both.
    await authorizeGenerationContent({
      ctx,
      generationId: ctx.params.generation_id,
      onDenied: 'refuse',
    });

    ctx.body = await getGenerationTranscript({
      generationId: ctx.params.generation_id,
      projectIds: projectIds ?? undefined,
    });
  }
);

/** `after_seq`, else the `Last-Event-ID` an `EventSource` reconnect sends. */
const parseAfterSeq = (ctx: Context): number => {
  const header = ctx.get('last-event-id');
  const raw = ctx.query['after_seq'] ?? (header === '' ? undefined : header);
  if (raw === undefined) return 0;
  const value =
    typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `after_seq must be an integer of at least 0; got ${JSON.stringify(raw)}.`,
      { field: 'after_seq' }
    );
  }
  return value;
};

/**
 * @openapi
 * GET /api/v1/generations/{generation_id}/events
 * operationId: listGenerationEvents
 * The generation's transcript, incrementally: its progress rows after
 * `after_seq`, each ended step carrying its content. `stream=true` serves them
 * as SSE until the generation settles; `progress_only=true` leaves the
 * content out, and with it the need for `traces:GetTrace`.
 */
generationsRouter.get(
  '/generations/:generation_id/events',
  async (ctx: Context) => {
    const { projectIds } = await generationAccess.authorizeRead({
      ctx,
      action: 'generations:GetGeneration',
    });
    const generationId = ctx.params.generation_id;
    const includeContent = ctx.query['progress_only'] !== 'true';
    if (includeContent) {
      await authorizeGenerationContent({
        ctx,
        generationId,
        onDenied: 'refuse',
      });
    }
    const afterSeq = parseAfterSeq(ctx);

    if (ctx.query['stream'] === 'true') {
      await serveGenerationEvents({
        ctx,
        generationId,
        afterSeq,
        includeContent,
        label: 'generation events',
      });
      return;
    }

    ctx.body = await listGenerationEvents({
      generationId,
      projectIds: projectIds ?? undefined,
      afterSeq,
      includeContent,
      ...parsePagination(ctx),
    });
  }
);

/**
 * @openapi
 * PATCH /api/v1/generations/{generation_id}
 * operationId: updateGeneration
 * Attaches caller-supplied key/value metadata to a generation, for per-run
 * audit attribution (e.g. the ticket or case an action belongs to).
 * The provided keys are shallow-merged over the existing metadata. The bag is
 * caller-owned: server state (usage attribution, the served agent version, the
 * model route's record, the memory-extraction summary, what retrieval served)
 * lives in its own top-level fields and cannot be reached from here.
 */
generationsRouter.patch('/generations/:generation_id', async (ctx: Context) => {
  const { projectIds } = await generationAccess.authorizeWrite({
    ctx,
    action: 'generations:UpdateGeneration',
  });

  const { metadata } = ctx.request.body as { metadata?: unknown };

  const metadataError = validateMetadataBag(metadata);
  if (metadataError) {
    throw new DomainError('VALIDATION_FAILED', metadataError);
  }

  ctx.body = requireFound({
    label: 'Generation',
    id: ctx.params.generation_id,
    value: await updateGenerationMetadata({
      publicId: ctx.params.generation_id,
      projectIds,
      metadata: metadata as Record<string, unknown>,
    }),
  });
});

/**
 * @openapi
 * DELETE /api/v1/generations/{generation_id}/content
 * operationId: purgeGenerationContent
 * Clears the generation's content (`metadata`, `error`, `extraction`, and the
 * internal recovery state), leaving the usage/audit skeleton — ids, timestamps,
 * status, and the attribution fields the billing ledger reads. Idempotent.
 */
generationsRouter.delete(
  '/generations/:generation_id/content',
  async (ctx: Context) => {
    const { projectIds } = await generationAccess.authorizeWrite({
      ctx,
      action: 'generations:PurgeGenerationContent',
    });

    ctx.body = requireFound({
      label: 'Generation',
      id: ctx.params.generation_id,
      value: await purgeGenerationContent({
        publicId: ctx.params.generation_id,
        projectIds,
        principal: requestPrincipalFromCtx(ctx),
      }),
    });
  }
);
