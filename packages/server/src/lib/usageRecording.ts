import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModelUsage } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { getEffectivePrice } from './priceBook';
import {
  buildTokenComponents,
  computeComponentCostUsd,
  sumComponentCostUsd,
  type TokenComponent,
} from './priceCompute';

const log = createDebug('soat:usage');

export type UsageTokens = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
};

/**
 * Normalizes an AI SDK `LanguageModelUsage` into token counts. Every field
 * defaults to 0 so a provider that omits a breakdown records 0 rather than
 * null — the counts stay summable.
 */
export const extractUsageTokens = (
  usage: LanguageModelUsage | undefined
): UsageTokens => {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    };
  }
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
  };
};

const metadataString = (
  metadata: Record<string, unknown>,
  key: string
): string | null => {
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
};

type GenerationWithAgent = InstanceType<(typeof db)['Generation']> & {
  agent?:
    | (InstanceType<(typeof db)['Agent']> & {
        aiProvider?: InstanceType<(typeof db)['AiProvider']> | null;
      })
    | null;
};

type Attribution = {
  aiProviderId: number | null;
  provider: string;
  actionId: string | null;
  triggerId: string | null;
  // Public id of the orchestration run that dispatched the generation, and the
  // node within it. Both arrive via generation metadata; `runPublicId` is
  // resolved to the internal FK at persist time. Null for standalone generations.
  runPublicId: string | null;
  nodeId: string | null;
};

// Pulls the event's attribution off the loaded generation: the billed AI
// provider (internal id + slug), the caller-supplied action / initiating
// trigger, and the orchestration run/node — all carried in the generation's
// metadata.
const resolveEventAttribution = (
  generation: GenerationWithAgent
): Attribution => {
  const aiProvider = generation.agent?.aiProvider ?? null;
  const metadata = generation.metadata ?? {};
  return {
    aiProviderId: aiProvider?.id ?? null,
    provider: aiProvider?.provider ?? 'unknown',
    actionId: metadataString(metadata, 'actionId'),
    triggerId: metadataString(metadata, 'triggerId'),
    runPublicId: metadataString(metadata, 'runId'),
    nodeId: metadataString(metadata, 'nodeId'),
  };
};

// Resolves the run's public id (carried in generation metadata) to its internal
// FK. Returns null when absent or the run no longer exists — the event is still
// recorded, just without the run association.
const resolveRunId = async (
  runPublicId: string | null
): Promise<number | null> => {
  if (!runPublicId) return null;
  const run = await db.OrchestrationRun.findOne({
    where: { publicId: runPublicId },
  });
  return (run?.id as number | undefined) ?? null;
};

// The idempotency key. Inside an orchestration run a generation is scoped to its
// node execution (`run:<run>:node:<node>`), so a replayed node upserts into a
// no-op instead of double counting. Standalone generations key on the
// generation's own public id.
const buildIdempotencyKey = (args: {
  generationPublicId: string;
  runPublicId: string | null;
  nodeId: string | null;
}): string => {
  if (args.runPublicId && args.nodeId) {
    return `run:${args.runPublicId}:node:${args.nodeId}`;
  }
  return args.generationPublicId;
};

type PricedComponent = TokenComponent & {
  unitPrice: string | null;
  costUsd: string | null;
  priceId: number | null;
};

// Prices one billable component at write time from the row effective now,
// resolved most-specific first: provider instance → project + slug → global.
// `cached_tokens` falls back to the `input_tokens` rate when no cached price is
// set (i.e. no cache discount). Non-billable components are never priced.
const priceComponent = async (args: {
  component: TokenComponent;
  provider: string;
  model: string;
  aiProviderId: number | null;
  projectId: number;
  at: Date;
}): Promise<PricedComponent> => {
  if (!args.component.billable) {
    return { ...args.component, unitPrice: null, costUsd: null, priceId: null };
  }

  const lookup = {
    provider: args.provider,
    model: args.model,
    aiProviderId: args.aiProviderId,
    projectId: args.projectId,
    at: args.at,
  };
  let price = await getEffectivePrice({
    ...lookup,
    component: args.component.component,
  });
  if (!price && args.component.component === 'cached_tokens') {
    price = await getEffectivePrice({ ...lookup, component: 'input_tokens' });
  }

  const unitPrice = price ? Number(price.unitPrice) : null;
  return {
    ...args.component,
    unitPrice: price ? String(price.unitPrice) : null,
    costUsd: computeComponentCostUsd({
      quantity: args.component.quantity,
      unitPrice,
    }),
    priceId: price?.id ?? null,
  };
};

const priceComponents = (args: {
  tokens: UsageTokens;
  attribution: Attribution;
  model: string;
  projectId: number;
}): Promise<PricedComponent[]> => {
  const at = new Date();
  return Promise.all(
    buildTokenComponents(args.tokens).map((component) => {
      return priceComponent({
        component,
        provider: args.attribution.provider,
        model: args.model,
        aiProviderId: args.attribution.aiProviderId,
        projectId: args.projectId,
        at,
      });
    })
  );
};

// Atomic + idempotent on the resolved key: a replayed completion (or a replayed
// orchestration node) finds the event already present and writes nothing,
// instead of double counting.
const persistEvent = async (args: {
  generation: GenerationWithAgent;
  attribution: Attribution;
  runId: number | null;
  idempotencyKey: string;
  model: string;
  priced: PricedComponent[];
  costUsd: string | null;
}): Promise<boolean> => {
  const { generation, attribution } = args;
  return db.sequelize.transaction(async (transaction) => {
    const [event, created] = await db.UsageEvent.findOrCreate({
      where: { idempotencyKey: args.idempotencyKey },
      defaults: {
        publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageEvent),
        projectId: generation.projectId,
        runId: args.runId,
        nodeId: attribution.nodeId,
        agentId: generation.agentId,
        generationId: generation.id,
        traceId: generation.traceId,
        aiProviderId: attribution.aiProviderId,
        triggerId: attribution.triggerId,
        actionId: attribution.actionId,
        meterType: 'llm_tokens',
        provider: attribution.provider,
        model: args.model,
        costUsd: args.costUsd,
        idempotencyKey: args.idempotencyKey,
      },
      transaction,
    });

    if (!created) return false;

    await db.UsageComponent.bulkCreate(
      args.priced.map((component) => {
        return {
          publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
          usageEventId: event.id,
          component: component.component,
          quantity: String(component.quantity),
          unit: component.unit,
          billable: component.billable,
          unitPrice: component.unitPrice,
          costUsd: component.costUsd,
          priceId: component.priceId,
        };
      }),
      { transaction }
    );
    return true;
  });
};

const writeGenerationEvent = async (args: {
  generationId: string;
  model: string;
  usage: LanguageModelUsage | undefined;
}): Promise<void> => {
  const generation = await db.Generation.findOne({
    where: { publicId: args.generationId },
    include: [
      {
        model: db.Agent,
        as: 'agent',
        include: [{ model: db.AiProvider, as: 'aiProvider' }],
      },
    ],
  });

  if (!generation) {
    log('writeGenerationEvent: generation not found id=%s', args.generationId);
    return;
  }

  const attribution = resolveEventAttribution(generation);
  const model = args.model || 'unknown';
  const priced = await priceComponents({
    tokens: extractUsageTokens(args.usage),
    attribution,
    model,
    projectId: generation.projectId,
  });
  const costUsd = sumComponentCostUsd(
    priced.map((c) => {
      return c.costUsd;
    })
  );

  const runId = await resolveRunId(attribution.runPublicId);
  const idempotencyKey = buildIdempotencyKey({
    generationPublicId: generation.publicId,
    runPublicId: attribution.runPublicId,
    nodeId: attribution.nodeId,
  });

  const created = await persistEvent({
    generation,
    attribution,
    runId,
    idempotencyKey,
    model,
    priced,
    costUsd,
  });
  log(
    'writeGenerationEvent: id=%s created=%s components=%d costUsd=%s',
    args.generationId,
    created,
    priced.length,
    costUsd
  );
};

/**
 * Writes one usage event (with its component rows) for a completed generation
 * from the provider's reported token usage. Idempotent on the generation's
 * public ID — a replayed completion is a no-op instead of double counting.
 * Never throws: metering is an observability side effect and must not fail the
 * generation it measures.
 */
export const recordGenerationUsage = async (args: {
  generationId: string;
  model: string;
  usage: LanguageModelUsage | undefined;
}): Promise<void> => {
  log(
    'recordGenerationUsage: generationId=%s model=%s',
    args.generationId,
    args.model
  );
  try {
    await writeGenerationEvent(args);
  } catch (error) {
    log(
      'recordGenerationUsage: failed generationId=%s error=%s',
      args.generationId,
      error instanceof Error ? error.message : String(error)
    );
  }
};
