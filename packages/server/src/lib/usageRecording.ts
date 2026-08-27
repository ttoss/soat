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

type GenerationWithAgent = InstanceType<(typeof db)['Generation']> & {
  agent?:
    | (InstanceType<(typeof db)['Agent']> & {
        aiProvider?: InstanceType<(typeof db)['AiProvider']> | null;
      })
    | null;
  startedByActor?: InstanceType<(typeof db)['Actor']> | null;
  session?: InstanceType<(typeof db)['Session']> | null;
};

type Attribution = {
  aiProviderId: number | null;
  provider: string;
  actionId: string | null;
  triggerId: string | null;
  // Public id of the orchestration run that dispatched the generation, and the
  // node within it. `runPublicId` is resolved to the internal FK at persist
  // time. Null for standalone generations.
  runPublicId: string | null;
  nodeId: string | null;
  // The node's 1-based retry attempt, part of the idempotency key so two
  // attempts of one node are two events. Null on a generation written before
  // the column existed, or by a path that dispatches without threading it.
  nodeAttempt: number | null;
};

// Read off typed generation columns, so a caller cannot bill another action,
// trigger or run.
const resolveEventAttribution = (
  generation: GenerationWithAgent
): Attribution => {
  const aiProvider = generation.agent?.aiProvider ?? null;
  return {
    aiProviderId: aiProvider?.id ?? null,
    provider: aiProvider?.provider ?? 'unknown',
    actionId: generation.actionId,
    triggerId: generation.triggerId,
    runPublicId: generation.orchestrationRunId,
    nodeId: generation.nodeId,
    nodeAttempt: generation.nodeAttempt,
  };
};

// Resolves the run's public id to its internal FK. Returns null when absent or
// the run no longer exists — the event is still recorded, just without the run
// association.
const resolveRunId = async (
  runPublicId: string | null
): Promise<number | null> => {
  if (!runPublicId) return null;
  const run = await db.OrchestrationRun.findOne({
    where: { publicId: runPublicId },
  });
  return (run?.id as number | undefined) ?? null;
};

// Scoped to the node execution *attempt*, so a replayed node upserts into a
// no-op while a retry — a different generation that really reached the provider
// — meters for real. Keying on `run:node` alone made the two indistinguishable
// and dropped the second attempt. A null attempt resolves to 1, so the first
// attempt has only one spelling.
const buildIdempotencyKey = (args: {
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
      { model: db.Actor, as: 'startedByActor' },
      { model: db.Session, as: 'session' },
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
  const actorTags = generation.startedByActor?.tags ?? {};
  const sessionTags = generation.session?.tags ?? {};
  const tags = { ...actorTags, ...sessionTags };
  const idempotencyKey = buildIdempotencyKey({
    generationPublicId: generation.publicId,
    runPublicId: attribution.runPublicId,
    nodeId: attribution.nodeId,
    nodeAttempt: attribution.nodeAttempt,
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
      // `eval` for an eval run's item generations, null for production traffic.
      // Copied off the generation's own column, so a caller cannot bill eval
      // spend as production or vice versa.
      source: generation.source,
      tags: Object.keys(tags).length > 0 ? tags : null,
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
        // A generation-less completion has no generation or agent row to
        // identify the workload by, so it labels itself: the same value that
        // names it in the idempotency key.
        source: args.source,
        tags: null,
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
