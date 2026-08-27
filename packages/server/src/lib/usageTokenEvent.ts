import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModelUsage } from 'ai';

import { db } from '../db';
import { getEffectivePrice } from './priceBook';
import {
  buildTokenComponents,
  computeComponentCostUsd,
  type TokenComponent,
} from './priceCompute';

/**
 * The shared primitives every `llm_tokens` event goes through: normalizing the
 * provider's reported usage, pricing each component at write time, and the
 * atomic idempotent insert. Both writers in `usageRecording.ts` — the
 * generation path and the generation-less completion path — build on these, so
 * a metered call is priced and persisted identically wherever it came from.
 */

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

export type PricedComponent = TokenComponent & {
  unitPrice: string | null;
  costUsd: string | null;
  priceId: number | null;
};

// Priced at write time from the row effective now, most-specific first:
// provider instance → project + slug → global. `cached_tokens` falls back to
// the `input_tokens` rate, i.e. no cache discount.
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

export const priceTokenComponents = (args: {
  tokens: UsageTokens;
  provider: string;
  aiProviderId: number | null;
  model: string;
  projectId: number;
}): Promise<PricedComponent[]> => {
  const at = new Date();
  return Promise.all(
    buildTokenComponents(args.tokens).map((component) => {
      return priceComponent({
        component,
        provider: args.provider,
        model: args.model,
        aiProviderId: args.aiProviderId,
        projectId: args.projectId,
        at,
      });
    })
  );
};

// All nullable but the project: a chat or memory completion has no Generation
// row behind it and still meters identically. `actorId`/`sessionId` are set
// only where an end user is behind the call, frozen at write time like `cost_usd`.
export type TokenEventAttribution = {
  projectId: number;
  orchestrationRunId: number | null;
  nodeId: string | null;
  agentId: number | null;
  generationId: number | null;
  traceId: number | null;
  actorId: number | null;
  sessionId: number | null;
  aiProviderId: number | null;
  triggerId: string | null;
  actionId: string | null;
  /**
   * The workload behind the spend when it is not production traffic (`eval`,
   * `eval_judge`); `null` for ordinary traffic. Required rather than optional so
   * a new metering call site has to say which it is instead of defaulting into
   * production spend.
   */
  source: string | null;
};

/**
 * Atomic + idempotent on the resolved key: a replayed completion (or a replayed
 * orchestration node) finds the event already present and writes nothing,
 * instead of double counting. Returns whether the event was newly created, so
 * the caller can fire threshold evaluation exactly once per real write.
 */
export const persistTokenEvent = async (args: {
  attribution: TokenEventAttribution;
  idempotencyKey: string;
  provider: string;
  model: string;
  priced: PricedComponent[];
  costUsd: string | null;
}): Promise<boolean> => {
  const { attribution } = args;
  return db.sequelize.transaction(async (transaction) => {
    const [event, created] = await db.UsageEvent.findOrCreate({
      where: { idempotencyKey: args.idempotencyKey },
      defaults: {
        publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageEvent),
        projectId: attribution.projectId,
        orchestrationRunId: attribution.orchestrationRunId,
        nodeId: attribution.nodeId,
        agentId: attribution.agentId,
        generationId: attribution.generationId,
        traceId: attribution.traceId,
        actorId: attribution.actorId,
        sessionId: attribution.sessionId,
        aiProviderId: attribution.aiProviderId,
        triggerId: attribution.triggerId,
        actionId: attribution.actionId,
        source: attribution.source,
        meterType: 'llm_tokens',
        provider: args.provider,
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
