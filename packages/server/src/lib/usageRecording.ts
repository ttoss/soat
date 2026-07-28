import { randomUUID } from 'node:crypto';

import type { LanguageModelUsage } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { sumComponentCostUsd } from './priceCompute';
import { evaluateProjectThresholds } from './usageThresholds';
import {
  extractUsageTokens,
  persistTokenEvent,
  priceTokenComponents,
} from './usageTokenEvent';

const log = createDebug('soat:usage');

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
    runPublicId: metadataString(metadata, 'orchestrationRunId'),
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
  const priced = await priceTokenComponents({
    tokens: extractUsageTokens(args.usage),
    provider: attribution.provider,
    aiProviderId: attribution.aiProviderId,
    model,
    projectId: generation.projectId,
  });
  const costUsd = sumComponentCostUsd(
    priced.map((c) => {
      return c.costUsd;
    })
  );

  const orchestrationRunId = await resolveRunId(attribution.runPublicId);
  const idempotencyKey = buildIdempotencyKey({
    generationPublicId: generation.publicId,
    runPublicId: attribution.runPublicId,
    nodeId: attribution.nodeId,
  });

  const created = await persistTokenEvent({
    attribution: {
      projectId: generation.projectId,
      orchestrationRunId,
      nodeId: attribution.nodeId,
      agentId: generation.agentId,
      generationId: generation.id,
      traceId: generation.traceId,
      // End-user attribution, copied from the generation's own FK columns.
      actorId: generation.startedByActorId,
      sessionId: generation.sessionId,
      aiProviderId: attribution.aiProviderId,
      triggerId: attribution.triggerId,
      actionId: attribution.actionId,
    },
    idempotencyKey,
    provider: attribution.provider,
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

  // Threshold evaluation is the choke point's responsibility: only a newly
  // written event can move a windowed total across a threshold, so a replayed
  // (idempotent no-op) event never re-fires. Best-effort — never throws.
  if (created) {
    await evaluateProjectThresholds({ projectId: generation.projectId });
  }
};

/**
 * The metered LLM paths that do not create a {@link db.Generation} row. Named
 * so the idempotency key says where the call came from when reconciling a bill
 * against the logs.
 */
export type CompletionUsageSource =
  'chat' | 'discussion' | 'memory_consolidation' | 'memory_extraction';

/**
 * Writes one `llm_tokens` usage event for a completed provider call that has no
 * Generation record behind it — a chat completion, a discussion turn, or a
 * memory extraction/consolidation pass. Attribution is explicit rather than read
 * off a generation: `generationId` and `traceId` are always null, `agentId` is
 * set only where the call is anchored to an agent.
 *
 * Unlike a generation or an orchestration node, these calls have no replay
 * identity — nothing re-delivers them, and a retried request is a genuinely new
 * provider call that must be billed. The idempotency key is therefore unique per
 * call (`completion:{source}:{uuid}`): it keeps the column's not-null uniqueness
 * contract without pretending to a de-duplication the path cannot have.
 *
 * Never throws: metering is an observability side effect and must not fail the
 * completion it measures.
 */
export const recordCompletionUsage = async (args: {
  source: CompletionUsageSource;
  projectId: number;
  provider: string;
  aiProviderId: number | null;
  agentId?: number | null;
  model: string;
  usage: LanguageModelUsage | undefined;
}): Promise<void> => {
  log(
    'recordCompletionUsage: source=%s projectId=%d model=%s',
    args.source,
    args.projectId,
    args.model
  );
  try {
    const model = args.model || 'unknown';
    const priced = await priceTokenComponents({
      tokens: extractUsageTokens(args.usage),
      provider: args.provider,
      aiProviderId: args.aiProviderId,
      model,
      projectId: args.projectId,
    });
    const costUsd = sumComponentCostUsd(
      priced.map((c) => {
        return c.costUsd;
      })
    );

    const created = await persistTokenEvent({
      attribution: {
        projectId: args.projectId,
        orchestrationRunId: null,
        nodeId: null,
        agentId: args.agentId ?? null,
        generationId: null,
        traceId: null,
        // Generation-less completions are not dispatched through a session, so
        // there is no end user to attribute them to.
        actorId: null,
        sessionId: null,
        aiProviderId: args.aiProviderId,
        triggerId: null,
        actionId: null,
      },
      idempotencyKey: `completion:${args.source}:${randomUUID()}`,
      provider: args.provider,
      model,
      priced,
      costUsd,
    });
    log(
      'recordCompletionUsage: source=%s created=%s components=%d costUsd=%s',
      args.source,
      created,
      priced.length,
      costUsd
    );

    // Same choke-point rule as the generation path: only a newly written event
    // can move a windowed total across a threshold.
    if (created) {
      await evaluateProjectThresholds({ projectId: args.projectId });
    }
  } catch (error) {
    log(
      'recordCompletionUsage: failed source=%s error=%s',
      args.source,
      error instanceof Error ? error.message : String(error)
    );
  }
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
