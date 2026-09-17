import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { purgeGenerationContent } from 'src/lib/contentPurge';
import {
  generations,
  getGeneration,
  getGenerationTraceId,
  listGenerations,
  updateGenerationMetadata,
} from 'src/lib/generations';
import { getGenerationTranscript } from 'src/lib/generationTranscript';
import { validateMetadataBag } from 'src/lib/metadataBag';
import { traceRows } from 'src/lib/traces';

import {
  requestPrincipalFromCtx,
  requireAuth,
  requireProjectAccess,
} from './helpers';
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
  param: 'generation_id',
  label: 'Generation',
});

/**
 * The generation a route resolved, past the `null` its lib lookup still
 * declares.
 *
 * Each route below runs after `generationAccess`, which resolved the generation
 * and its project, and then re-reads it narrowed to exactly that project — so
 * the second lookup cannot miss. The lib signatures stay nullable because other
 * callers pass a wider scope; this is the one place that difference is
 * reconciled, rather than three unreachable guards that read as though a miss
 * were expected.
 */
const requireResolved = <T>(args: { value: T | null; ctx: Context }): T => {
  if (!args.value) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${args.ctx.params.generation_id}' not found.`
    );
  }
  return args.value;
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

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'generations:ListGenerations',
    resourceType: 'generation',
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
    status,
    limit,
    offset,
  } = ctx.query as Record<string, string | undefined>;

  const result = await listGenerations({
    projectIds: projectIds ?? undefined,
    agentId,
    traceId,
    sessionId,
    actorId,
    initiatorGenerationId,
    chainId,
    orchestrationRunId,
    nodeId,
    status,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });

  ctx.body = result;
});

/**
 * @openapi
 * GET /api/v1/generations/{generation_id}
 * operationId: getGeneration
 * Returns a single generation record by public ID, including its status
 * ('in_progress', 'requires_action', 'completed', or 'failed') and the
 * structured error payload when the generation failed.
 */
generationsRouter.get('/generations/:generation_id', async (ctx: Context) => {
  const { projectIds } = await generationAccess.authorizeRead({
    ctx,
    action: 'generations:GetGeneration',
  });

  ctx.body = requireResolved({
    ctx,
    value: await getGeneration({
      publicId: ctx.params.generation_id,
      projectIds,
      includeUsage: true,
    }),
  });
});

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
    // caller must be allowed to read both — otherwise `GetGeneration` alone
    // would silently widen to cover trace content reachable today only through
    // `GET /traces/{id}`. Deriving authority from exactly the two resources
    // projected also keeps it from drifting from them later; each is
    // now named by its own SRN.
    //
    // A refusal here stays `403` rather than hiding: the generation read above
    // already succeeded, so the caller knows the turn exists, and every
    // generation has a trace. There is nothing left to conceal.
    const traceId = await getGenerationTraceId({
      id: ctx.params.generation_id,
    });
    await authorizeResource({
      ctx,
      scope: await traceRows.findScope({ id: traceId }),
      resourceType: 'trace',
      resourceId: traceId,
      label: 'Trace',
      action: 'traces:GetTrace',
      onDenied: 'refuse',
    });

    ctx.body = await getGenerationTranscript({
      generationId: ctx.params.generation_id,
      projectIds: projectIds ?? undefined,
    });
  }
);

/**
 * @openapi
 * PATCH /api/v1/generations/{generation_id}
 * operationId: updateGeneration
 * Attaches caller-supplied key/value metadata to a generation, for per-run
 * audit attribution (e.g. which knowledge-corpus version produced an action).
 * The provided keys are shallow-merged over the existing metadata. The bag is
 * caller-owned: server state (usage attribution, the served agent version, the
 * model route's record, the memory-extraction summary) lives in its own
 * top-level fields and cannot be reached from here.
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

  ctx.body = requireResolved({
    ctx,
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

    ctx.body = requireResolved({
      ctx,
      value: await purgeGenerationContent({
        publicId: ctx.params.generation_id,
        projectIds,
        principal: requestPrincipalFromCtx(ctx),
      }),
    });
  }
);
