import { randomUUID } from 'node:crypto';

import type { LanguageModelUsage } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { sumComponentCostUsd } from './priceCompute';
import { readGenerationEventAttribution } from './usageGenerationAttribution';
import { evaluateProjectThresholds } from './usageThresholds';
import type { PricedComponent } from './usageTokenEvent';
import {
  extractUsageTokens,
  persistTokenEvent,
  priceTokenComponents,
} from './usageTokenEvent';

const log = createDebug('soat:usage');

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
  // Public id of the orchestration run that dispatched the generation, and the
  // node within it — what keys a node's event. Null for standalone generations.
  runPublicId: string | null;
  nodeId: string | null;
  // The node's 1-based retry attempt, part of the idempotency key so two
  // attempts of one node are two events. Null on a generation written before
  // the column existed, or by a path that dispatches without threading it.
  nodeAttempt: number | null;
};

/**
 * The provider the event bills against: the route's serving target where the
 * turn was routed, the agent's pinned provider otherwise.
 *
 * A routed agent pins nothing, so without the served target its spend meters
 * against no provider and under the `unknown` slug — unpriced, and unnameable
 * in a rollup that groups by model.
 */
const resolveBillingProvider = async (args: {
  generation: GenerationWithAgent;
  servedAiProviderId?: string | null;
}): Promise<{ id: number; provider: string } | null> => {
  if (args.servedAiProviderId) {
    const served = await db.AiProvider.findOne({
      where: {
        publicId: args.servedAiProviderId,
        projectId: args.generation.projectId,
      },
    });
    // Falls through to the pin when the row is gone (a delete racing the turn),
    // rather than dropping the attribution the pin would still have given.
    if (served) return { id: served.id, provider: served.provider };
  }
  const pinned = args.generation.agent?.aiProvider ?? null;
  return pinned ? { id: pinned.id, provider: pinned.provider } : null;
};

// Read off typed generation columns, so a caller cannot bill another provider
// or key the event to another run.
const resolveEventAttribution = (args: {
  generation: GenerationWithAgent;
  aiProvider: { id: number; provider: string } | null;
}): Attribution => {
  const { generation, aiProvider } = args;
  return {
    aiProviderId: aiProvider?.id ?? null,
    provider: aiProvider?.provider ?? 'unknown',
    runPublicId: generation.orchestrationRunId,
    nodeId: generation.nodeId,
    nodeAttempt: generation.nodeAttempt,
  };
};

// Scoped to the node execution *attempt*, so a replayed node upserts into a
// no-op while a retry — a different generation that really reached the provider
// — meters for real. Keying on `run:node` alone made the two indistinguishable
// and dropped the second attempt. A null attempt resolves to 1, so the first
// attempt has only one spelling.
const buildGenerationKey = (args: {
  generationPublicId: string;
  runPublicId: string | null;
  nodeId: string | null;
  nodeAttempt: number | null;
}): string => {
  if (args.runPublicId && args.nodeId) {
    const attempt = args.nodeAttempt ?? 1;
    return `run:${args.runPublicId}:node:${args.nodeId}:attempt:${attempt}`;
  }
  return args.generationPublicId;
};

// One key per segment of the turn: a turn pausing on a client tool spends
// provider calls on both sides of the pause, and a segment is identified by the
// steps spent before it. The first segment keeps the bare generation key.
const buildIdempotencyKey = (
  args: Parameters<typeof buildGenerationKey>[0] & { stepsAlreadySpent: number }
): string => {
  const generationKey = buildGenerationKey(args);
  return args.stepsAlreadySpent > 0
    ? `${generationKey}:step:${args.stepsAlreadySpent}`
    : generationKey;
};

// The priced components and their summed cost for one set of reported tokens.
// Shared by both writers so a generation-backed event and a generation-less
// completion can never price the same tokens differently.
const priceTokens = async (args: {
  usage: LanguageModelUsage | undefined;
  provider: string;
  aiProviderId: number | null;
  model: string;
  projectId: number;
}): Promise<{ priced: PricedComponent[]; costUsd: string | null }> => {
  const priced = await priceTokenComponents({
    tokens: extractUsageTokens(args.usage),
    provider: args.provider,
    aiProviderId: args.aiProviderId,
    model: args.model,
    projectId: args.projectId,
  });
  return {
    priced,
    costUsd: sumComponentCostUsd(
      priced.map((component) => {
        return component.costUsd;
      })
    ),
  };
};

const writeGenerationEvent = async (args: {
  generationId: string;
  model: string;
  usage: LanguageModelUsage | undefined;
  aiProviderId?: string | null;
  stepsAlreadySpent: number;
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

  const attribution = resolveEventAttribution({
    generation,
    aiProvider: await resolveBillingProvider({
      generation,
      servedAiProviderId: args.aiProviderId,
    }),
  });
  const model = args.model || 'unknown';
  const { priced, costUsd } = await priceTokens({
    usage: args.usage,
    provider: attribution.provider,
    aiProviderId: attribution.aiProviderId,
    model,
    projectId: generation.projectId,
  });

  const idempotencyKey = buildIdempotencyKey({
    generationPublicId: generation.publicId,
    runPublicId: attribution.runPublicId,
    nodeId: attribution.nodeId,
    nodeAttempt: attribution.nodeAttempt,
    stepsAlreadySpent: args.stepsAlreadySpent,
  });

  const created = await persistTokenEvent({
    attribution: {
      ...(await readGenerationEventAttribution(generation)),
      projectId: generation.projectId,
      aiProviderId: attribution.aiProviderId,
      documentId: null,
      memoryStoreId: null,
      // `eval` for an eval run's item generations, null for production traffic.
      // Copied off the generation's own column, so a caller cannot bill eval
      // spend as production or vice versa.
      source: generation.source,
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
  | 'chat'
  | 'memory_consolidation'
  | 'memory_extraction'
  // Separate from the `eval` source the graded generations carry, so a rollup
  // prices running a suite apart from grading it — judging doubles the calls.
  | 'eval_judge';

/**
 * Writes one `llm_tokens` usage event for a completed provider call that has no
 * Generation record behind it — a chat completion or a
 * memory store extraction/consolidation pass. Attribution is explicit rather than read
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
    const { priced, costUsd } = await priceTokens({
      usage: args.usage,
      provider: args.provider,
      aiProviderId: args.aiProviderId,
      model,
      projectId: args.projectId,
    });

    const created = await persistTokenEvent({
      attribution: {
        projectId: args.projectId,
        orchestrationRunId: null,
        nodeId: null,
        agentId: args.agentId ?? null,
        generationId: null,
        generationPublicId: null,
        traceId: null,
        // Generation-less completions are not dispatched through a session, so
        // there is no end user to attribute them to.
        actorId: null,
        sessionId: null,
        aiProviderId: args.aiProviderId,
        triggerId: null,
        actionId: null,
        documentId: null,
        memoryStoreId: null,
        // A generation-less completion has no generation or agent row to
        // identify the workload by, so it labels itself: the same value that
        // names it in the idempotency key.
        source: args.source,
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
 * Writes one usage event (with its component rows) for one segment of a
 * generation's turn from the provider's reported token usage. Idempotent on the
 * generation and the segment — a replayed segment is a no-op instead of double
 * counting. Never throws: metering is an observability side effect and must not
 * fail the generation it measures.
 */
export const recordGenerationUsage = async (args: {
  generationId: string;
  model: string;
  usage: LanguageModelUsage | undefined;
  /**
   * Public ID of the provider a model route picked for this turn. Omitted (or
   * null) on a non-routed turn, where the agent's pin is the answer.
   */
  aiProviderId?: string | null;
  /**
   * Steps the turn spent before the segment being metered: `0` for a turn's
   * first `generateText` call, the paused steps' count for a resumed one.
   */
  stepsAlreadySpent: number;
}): Promise<void> => {
  log(
    'recordGenerationUsage: generationId=%s model=%s stepsAlreadySpent=%d',
    args.generationId,
    args.model,
    args.stepsAlreadySpent
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
