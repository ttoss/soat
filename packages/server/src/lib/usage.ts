import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModelUsage } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { computeCostUsd, getEffectivePrice } from './priceBook';

export type {
  UsageReceipt,
  UsageReceiptLine,
  UsageReceiptMeterTypeTotal,
} from './usageReceipt';
export { getReceipt } from './usageReceipt';

const log = createDebug('soat:usage');

export type UsageTokens = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
};

/**
 * Normalizes an AI SDK `LanguageModelUsage` into the meter's token columns.
 * Every field defaults to 0 so a provider that omits a breakdown (e.g. no
 * reasoning tokens) records 0 rather than null — the counts stay summable.
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

export type PersistedUsageMeter = {
  id: string;
  projectId: string;
  runId: string | null;
  nodeId: string | null;
  agentId: string | null;
  generationId: string | null;
  traceId: string | null;
  aiProviderId: string | null;
  triggerId: string | null;
  actionId: string | null;
  meterType: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  quantity: number | null;
  unit: string | null;
  costUsd: number | null;
  priceId: string | null;
  createdAt: Date;
};

const assocPublicId = (
  assoc: { publicId: string } | null | undefined
): string | null => {
  return assoc?.publicId ?? null;
};

const metadataString = (
  metadata: Record<string, unknown>,
  key: string
): string | null => {
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
};

const mapUsageMeter = (
  meter: InstanceType<(typeof db)['UsageMeter']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agent?: InstanceType<(typeof db)['Agent']> | null;
    generation?: InstanceType<(typeof db)['Generation']> | null;
    run?: InstanceType<(typeof db)['OrchestrationRun']> | null;
    trace?: InstanceType<(typeof db)['Trace']> | null;
    aiProvider?: InstanceType<(typeof db)['AiProvider']> | null;
    price?: InstanceType<(typeof db)['PriceBook']> | null;
  }
): PersistedUsageMeter => {
  if (!meter.project) {
    throw new Error('UsageMeter project association is required.');
  }

  return {
    id: meter.publicId,
    projectId: meter.project.publicId,
    runId: assocPublicId(meter.run),
    nodeId: meter.nodeId,
    agentId: assocPublicId(meter.agent),
    generationId: assocPublicId(meter.generation),
    traceId: assocPublicId(meter.trace),
    aiProviderId: assocPublicId(meter.aiProvider),
    triggerId: meter.triggerId,
    actionId: meter.actionId,
    meterType: meter.meterType,
    provider: meter.provider,
    model: meter.model,
    inputTokens: meter.inputTokens,
    outputTokens: meter.outputTokens,
    cachedTokens: meter.cachedTokens,
    reasoningTokens: meter.reasoningTokens,
    quantity: meter.quantity === null ? null : Number(meter.quantity),
    unit: meter.unit,
    costUsd: meter.costUsd === null ? null : Number(meter.costUsd),
    priceId: assocPublicId(meter.price),
    createdAt: meter.createdAt,
  };
};

// Pulls the meter's attribution off the loaded generation: the billed AI
// provider (internal id + slug) and the caller-supplied action / initiating
// trigger carried in the generation's metadata.
const resolveMeterAttribution = (
  generation: InstanceType<(typeof db)['Generation']> & {
    agent?:
      | (InstanceType<(typeof db)['Agent']> & {
          aiProvider?: InstanceType<(typeof db)['AiProvider']> | null;
        })
      | null;
  }
): {
  aiProviderId: number | null;
  provider: string;
  actionId: string | null;
  triggerId: string | null;
} => {
  const aiProvider = generation.agent?.aiProvider ?? null;
  const metadata = generation.metadata ?? {};
  return {
    aiProviderId: aiProvider?.id ?? null,
    provider: aiProvider?.provider ?? 'unknown',
    actionId: metadataString(metadata, 'actionId'),
    triggerId: metadataString(metadata, 'triggerId'),
  };
};

const writeGenerationMeter = async (args: {
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
    log(
      'writeGenerationMeter: generation not found generationId=%s',
      args.generationId
    );
    return;
  }

  const tokens = extractUsageTokens(args.usage);
  const attribution = resolveMeterAttribution(generation);
  const model = args.model || 'unknown';

  // Price at write time from the row effective now, resolved most-specific
  // first: provider instance → project + slug → global default. Frozen onto the
  // meter so later price changes never alter this recorded cost. Null unpriced.
  const price = await getEffectivePrice({
    provider: attribution.provider,
    model,
    aiProviderId: attribution.aiProviderId,
    projectId: generation.projectId,
    at: new Date(),
  });
  const costUsd = computeCostUsd({ price, ...tokens });
  const priceId = price?.id ?? null;

  const [, created] = await db.UsageMeter.findOrCreate({
    where: { idempotencyKey: args.generationId },
    defaults: {
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageMeter),
      projectId: generation.projectId,
      runId: null,
      nodeId: null,
      agentId: generation.agentId,
      generationId: generation.id,
      traceId: generation.traceId,
      aiProviderId: attribution.aiProviderId,
      triggerId: attribution.triggerId,
      actionId: attribution.actionId,
      meterType: 'llm_tokens',
      provider: attribution.provider,
      model,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cachedTokens: tokens.cachedTokens,
      reasoningTokens: tokens.reasoningTokens,
      quantity: null,
      unit: null,
      costUsd,
      priceId,
      idempotencyKey: args.generationId,
    },
  });

  log(
    'writeGenerationMeter: generationId=%s created=%s reasoningTokens=%d',
    args.generationId,
    created,
    tokens.reasoningTokens
  );
};

/**
 * Writes one usage-meter row for a completed generation from the provider's
 * reported token usage. Idempotent on the generation's public ID — a replayed
 * completion is a no-op instead of double counting. Never throws: metering is
 * an observability side effect and must not fail the generation it measures.
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
    await writeGenerationMeter(args);
  } catch (error) {
    log(
      'recordGenerationUsage: failed generationId=%s error=%s',
      args.generationId,
      error instanceof Error ? error.message : String(error)
    );
  }
};

// Resolves a project-scoped resource publicId (agent/generation) to its
// internal id. Returns null when it does not exist in scope so the caller can
// yield an empty page instead of leaking cross-tenant rows.
const resolveScopedId = async (
  find: (where: {
    publicId: string;
    projectId?: number[];
  }) => Promise<{ id?: number } | null>,
  publicId: string,
  projectIds?: number[]
): Promise<number | null> => {
  const where: { publicId: string; projectId?: number[] } = { publicId };
  if (projectIds !== undefined) where.projectId = projectIds;
  const row = await find(where);
  return row?.id ?? null;
};

// Resolves agent/generation/trace publicId filters into `where` (mutating it).
// Returns false when a referenced resource does not exist in scope.
const applyUsageScopeFilters = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: Record<string, any>,
  args: {
    agentId?: string;
    generationId?: string;
    traceId?: string;
    projectIds?: number[];
  }
): Promise<boolean> => {
  if (args.agentId !== undefined) {
    const agentId = await resolveScopedId(
      (w) => {
        return db.Agent.findOne({ where: w });
      },
      args.agentId,
      args.projectIds
    );
    if (agentId === null) return false;
    where.agentId = agentId;
  }
  if (args.generationId !== undefined) {
    const generationId = await resolveScopedId(
      (w) => {
        return db.Generation.findOne({ where: w });
      },
      args.generationId,
      args.projectIds
    );
    if (generationId === null) return false;
    where.generationId = generationId;
  }
  if (args.traceId !== undefined) {
    const traceId = await resolveScopedId(
      (w) => {
        return db.Trace.findOne({ where: w });
      },
      args.traceId,
      args.projectIds
    );
    if (traceId === null) return false;
    where.traceId = traceId;
  }
  return true;
};

export const listUsageMeters = async (args: {
  projectIds?: number[];
  agentId?: string;
  generationId?: string;
  traceId?: string;
  triggerId?: string;
  actionId?: string;
  meterType?: string;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  const empty = { data: [], total: 0, limit, offset };

  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0) return empty;
    where.projectId = args.projectIds;
  }

  // triggerId/actionId/meterType are denormalized columns — filter directly.
  if (args.triggerId !== undefined) where.triggerId = args.triggerId;
  if (args.actionId !== undefined) where.actionId = args.actionId;
  if (args.meterType !== undefined) where.meterType = args.meterType;

  const resolved = await applyUsageScopeFilters(where, {
    agentId: args.agentId,
    generationId: args.generationId,
    traceId: args.traceId,
    projectIds: args.projectIds,
  });
  if (!resolved) return empty;

  const { count, rows } = await db.UsageMeter.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Agent, as: 'agent' },
      { model: db.Generation, as: 'generation' },
      { model: db.OrchestrationRun, as: 'run' },
      { model: db.Trace, as: 'trace' },
      { model: db.AiProvider, as: 'aiProvider' },
      { model: db.PriceBook, as: 'price' },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return { data: rows.map(mapUsageMeter), total: count, limit, offset };
};
