import { randomUUID } from 'node:crypto';

import createDebug from 'debug';

import { buildEmbeddingComponents, sumComponentCostUsd } from './priceCompute';
import { evaluateProjectThresholds } from './usageThresholds';
import { persistTokenEvent, priceComponents } from './usageTokenEvent';

const log = createDebug('soat:usage');

/**
 * The workload label every embedding event carries. Separate from the
 * generation and completion sources so a rollup can price retrieval and
 * ingestion apart from the turns that read them (#1208).
 */
export const EMBEDDING_USAGE_SOURCE = 'embedding';

/**
 * Writes one `llm_tokens` usage event for a completed embedding call.
 *
 * The embedding stack is configured per deployment (`EMBEDDING_PROVIDER` /
 * `EMBEDDING_MODEL`), not by an `AiProvider` row, so the event bills against the
 * provider *slug* with `ai_provider_id = null`: pricing resolves at the project
 * + slug tier, then the global default. A price book that names the embedding
 * model therefore prices every project's embeddings without a per-project row.
 *
 * Like a generation-less completion, an embedding call has no replay identity —
 * nothing re-delivers it and a retried request really did reach the provider —
 * so the idempotency key is unique per call (`embedding:{uuid}`).
 *
 * Never throws: metering is an observability side effect and must not fail the
 * call it measures. An embedding failure is already non-fatal on most callers
 * (a chunk is stored without a vector); a metering failure must not be worse.
 */
export const recordEmbeddingUsage = async (args: {
  projectId: number;
  provider: string;
  model: string;
  tokens: number;
}): Promise<void> => {
  log(
    'recordEmbeddingUsage: projectId=%d provider=%s model=%s tokens=%d',
    args.projectId,
    args.provider,
    args.model,
    args.tokens
  );
  try {
    const model = args.model || 'unknown';
    const priced = await priceComponents({
      components: buildEmbeddingComponents({ tokens: args.tokens }),
      provider: args.provider,
      aiProviderId: null,
      model,
      projectId: args.projectId,
    });
    const costUsd = sumComponentCostUsd(
      priced.map((component) => {
        return component.costUsd;
      })
    );

    const created = await persistTokenEvent({
      attribution: {
        projectId: args.projectId,
        orchestrationRunId: null,
        nodeId: null,
        agentId: null,
        generationId: null,
        traceId: null,
        // An embedding call is dispatched by ingestion, retrieval or the
        // embeddings endpoint — none of which runs as an end user.
        actorId: null,
        sessionId: null,
        aiProviderId: null,
        triggerId: null,
        actionId: null,
        source: EMBEDDING_USAGE_SOURCE,
      },
      idempotencyKey: `embedding:${randomUUID()}`,
      provider: args.provider,
      model,
      priced,
      costUsd,
    });
    log(
      'recordEmbeddingUsage: created=%s tokens=%d costUsd=%s',
      created,
      args.tokens,
      costUsd
    );

    // Same choke-point rule as every other meter: only a newly written event
    // can move a windowed total across a threshold.
    if (created) {
      await evaluateProjectThresholds({ projectId: args.projectId });
    }
  } catch (error) {
    log(
      'recordEmbeddingUsage: failed projectId=%d error=%s',
      args.projectId,
      error instanceof Error ? error.message : String(error)
    );
  }
};
