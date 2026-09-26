import { randomUUID } from 'node:crypto';

import createDebug from 'debug';

import { db } from '../db';
import { readEmbeddingInputTokenPriceUsd } from './embeddingPrice';
import {
  buildEmbeddingComponents,
  computeComponentCostUsd,
  sumComponentCostUsd,
} from './priceCompute';
import {
  type GenerationEventAttribution,
  readGenerationEventAttribution,
} from './usageGenerationAttribution';
import { evaluateProjectThresholds } from './usageThresholds';
import { persistTokenEvent, type PricedComponent } from './usageTokenEvent';

const log = createDebug('soat:usage');

/**
 * The workload label every embedding event carries. Separate from the
 * generation and completion sources so a rollup can price retrieval and
 * ingestion apart from the turns that read them, and so quota
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

const UNATTRIBUTED: GenerationEventAttribution = {
  orchestrationRunId: null,
  nodeId: null,
  agentId: null,
  generationId: null,
  generationPublicId: null,
  traceId: null,
  actorId: null,
  sessionId: null,
  triggerId: null,
  actionId: null,
};

/**
 * The attribution an embedding made for `generationId` is written with: the
 * generation's own when its record exists, else its public id alone, which
 * {@link withGenerationEmbeddingUsage} completes once the record commits.
 */
const resolveEmbeddingAttribution = async (args: {
  projectId: number;
  generationId: string | null;
}): Promise<GenerationEventAttribution> => {
  if (!args.generationId) return UNATTRIBUTED;
  const generation = await db.Generation.findOne({
    where: { publicId: args.generationId, projectId: args.projectId },
  });
  return generation
    ? readGenerationEventAttribution(generation)
    : { ...UNATTRIBUTED, generationPublicId: args.generationId };
};

/**
 * Writes one `llm_tokens` usage event for a completed embedding call.
 *
 * The embedding stack is configured per deployment (`EMBEDDING_PROVIDER` /
 * `EMBEDDING_MODEL`), not by an `AiProvider` row, so the event bills against
 * the provider *slug* with `ai_provider_id = null` and is priced from
 * `EMBEDDING_INPUT_1M_TOKEN_PRICE_USD`. An unset rate meters at zero, so an
 * embedding always carries a cost and can never make a `cost_usd` quota
 * unenforceable.
 *
 * Like a generation-less completion, an embedding call has no replay identity —
 * nothing re-delivers it and a retried request really did reach the provider —
 * so the idempotency key is unique per call (`embedding:{uuid}`).
 *
 * `generationId` names the generation the embedding was made for — a retrieval
 * ahead of an agent's turn — and is null for ingestion, memory writes and the
 * embeddings endpoint, which run for no generation.
 *
 * Never throws: metering is an observability side effect and must not fail the
 * call it measures. An embedding failure is already non-fatal on most callers
 * (a chunk is stored without a vector); a metering failure must not be worse.
 */
export const recordEmbeddingUsage = async (args: {
  projectId: number;
  generationId: string | null;
  provider: string;
  model: string;
  tokens: number;
}): Promise<void> => {
  log(
    'recordEmbeddingUsage: projectId=%d generationId=%s provider=%s model=%s tokens=%d',
    args.projectId,
    args.generationId,
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
        ...(await resolveEmbeddingAttribution(args)),
        projectId: args.projectId,
        aiProviderId: null,
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

type PendingEmbeddings = {
  projectId: number;
  generationPublicId: string;
  generationId: null;
  source: typeof EMBEDDING_USAGE_SOURCE;
};

// Counted first: most generations retrieve nothing, and they pay one indexed
// count rather than a generation read.
const linkPendingEmbeddings = async (where: PendingEmbeddings) => {
  if ((await db.UsageEvent.count({ where })) === 0) return;
  const generation = await db.Generation.findOne({
    where: { publicId: where.generationPublicId, projectId: where.projectId },
  });
  /* istanbul ignore if -- the record committed just before this read */
  if (!generation) return;
  await db.UsageEvent.update(await readGenerationEventAttribution(generation), {
    where,
  });
};

/**
 * Wraps the write of a generation's record, the one step every generation
 * takes, so the embeddings made before it are attributed exactly when the
 * record exists: linked to the committed row, or stripped of the generation
 * they named when the write fails, leaving them billed to the project alone.
 *
 * Never throws on its own account: attribution is bookkeeping, and the write's
 * own outcome is what the caller receives.
 */
export const withGenerationEmbeddingUsage = async <
  RecordArgs extends { projectId: number; publicId: string },
  T,
>(args: {
  record: RecordArgs;
  create: (record: RecordArgs) => Promise<T>;
}): Promise<T> => {
  const pending: PendingEmbeddings = {
    projectId: args.record.projectId,
    generationPublicId: args.record.publicId,
    generationId: null,
    source: EMBEDDING_USAGE_SOURCE,
  };
  let created: T;
  try {
    created = await args.create(args.record);
  } catch (error) {
    await db.UsageEvent.update(
      { generationPublicId: null },
      { where: pending }
    ).catch((detachError) => {
      log('withGenerationEmbeddingUsage: detach failed error=%s', detachError);
    });
    throw error;
  }
  await linkPendingEmbeddings(pending).catch((error) => {
    log('withGenerationEmbeddingUsage: link failed error=%s', error);
  });
  return created;
};
