import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { purgeGenerationContent } from 'src/lib/contentPurge';
import {
  getGeneration,
  listGenerations,
  updateGenerationMetadata,
} from 'src/lib/generations';
import { getGenerationTranscript } from 'src/lib/generationTranscript';
import { validateMetadataBag } from 'src/lib/metadataBag';

import {
  requestPrincipalFromCtx,
  requireAuth,
  requireProjectAccess,
} from './helpers';

export const generationsRouter = new Router<Context>();

/**
 * @openapi
 * GET /api/v1/generations
 * operationId: listGenerations
 * Lists generations the caller can access, optionally filtered by agent_id,
 * trace_id, chain_id, orchestration_run_id, node_id, and status. Replaces
 * the former GET /traces/{trace_id}/generations.
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
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'generations:GetGeneration',
    resourceType: 'generation',
  });

  const generation = await getGeneration({
    publicId: ctx.params.generation_id,
    projectIds,
  });

  if (!generation) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${ctx.params.generation_id}' not found.`
    );
  }

  ctx.body = generation;
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
    requireAuth(ctx);

    const projectIds = await requireProjectAccess({
      ctx,
      action: 'generations:GetGeneration',
      resourceType: 'generation',
    });

    // The response merges generation columns with the trace's steps, so the
    // caller must be allowed to read both — otherwise `GetGeneration` alone
    // would silently widen to cover trace content reachable today only through
    // `GET /traces/{id}`. Deriving authority from exactly the two resources
    // projected also keeps it from drifting from them later (#1012).
    await requireProjectAccess({
      ctx,
      action: 'traces:GetTrace',
      resourceType: 'trace',
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
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'generations:UpdateGeneration',
    resourceType: 'generation',
  });

  const { metadata } = ctx.request.body as { metadata?: unknown };

  const metadataError = validateMetadataBag(metadata);
  if (metadataError) {
    throw new DomainError('VALIDATION_FAILED', metadataError);
  }

  const generation = await updateGenerationMetadata({
    publicId: ctx.params.generation_id,
    projectIds: projectIds ?? undefined,
    metadata: metadata as Record<string, unknown>,
  });

  if (!generation) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${ctx.params.generation_id}' not found.`
    );
  }

  ctx.body = generation;
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
    requireAuth(ctx);

    const projectIds = await requireProjectAccess({
      ctx,
      action: 'generations:PurgeGenerationContent',
      resourceType: 'generation',
    });

    const purged = await purgeGenerationContent({
      publicId: ctx.params.generation_id,
      projectIds,
      principal: requestPrincipalFromCtx(ctx),
    });

    if (!purged) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Generation '${ctx.params.generation_id}' not found.`
      );
    }

    ctx.body = purged;
  }
);
