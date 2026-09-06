import { randomUUID } from 'node:crypto';

import createDebug from 'debug';

import { readEmbeddingInputTokenPriceUsd } from './embeddingPrice';
import {
  buildEmbeddingComponents,
  computeComponentCostUsd,
  sumComponentCostUsd,
} from './priceCompute';
import { evaluateProjectThresholds } from './usageThresholds';
import { persistTokenEvent, type PricedComponent } from './usageTokenEvent';

const log = createDebug('soat:usage');

/**
 * The workload label every embedding event carries. Separate from the
 * generation and completion sources so a rollup can price retrieval and
 * ingestion apart from the turns that read them (#1208), and so quota
 * enforcement can tell a call the tenant configured from one the deployment
 * did.
 */
export const EMBEDDING_USAGE_SOURCE = 'embedding';

/**
 * Prices an embedding's one component from the deployment's configured rate.
 *
 * The price book is not consulted: an embedding carries no `AiProvider` row for
 * its provider-instance tier to match, and the rate lives beside the model it
 * prices instead (`embeddingPrice.ts`). `priceId` is null for the same reason —
 * no row explains this cost, the configuration does.
 */
const priceEmbeddingComponents = (args: {
  tokens: number;
}): PricedComponent[] => {
  const unitPrice = readEmbeddingInputTokenPriceUsd();
  return buildEmbeddingComponents({ tokens: args.tokens }).map((component) => {
    return {
      ...component,
      unitPrice,
      costUsd: computeComponentCostUsd({
        quantity: component.quantity,
        unitPrice: Number(unitPrice),
      }),
      priceId: null,
    };
  });
};

/**
 * Writes one `llm_tokens` usage event for a completed embedding call.
 *
 * The embedding stack is configured per deployment (`EMBEDDING_PROVIDER` /
 * `EMBEDDING_MODEL`), not by an `AiProvider` row, so the event bills against
 * the provider *slug* with `ai_provider_id = null` and is priced from
 * `EMBEDDING_INPUT_1M_TOKEN_PRICE_USD`. An unset rate meters at zero, so an
 * embedding always carries a cost and can never make a `cost_usd` quota
 * unenforceable (#1213).
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
    const priced = priceEmbeddingComponents({ tokens: args.tokens });
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
      model: args.model,
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
    /* istanbul ignore else -- the key is a fresh uuid per call, so the write is
       never the idempotent no-op the other meters guard against */
    if (created) {
      await evaluateProjectThresholds({ projectId: args.projectId });
    }
  } catch (error) {
    log(
      'recordEmbeddingUsage: failed projectId=%d error=%s',
      args.projectId,
      error
    );
  }
};
