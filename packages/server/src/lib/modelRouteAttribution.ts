import type { LanguageModel, LanguageModelUsage } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { readRoutingMetadata } from './modelRouteExecutor';
import {
  type CompletionUsageSource,
  recordCompletionUsage,
} from './usageRecording';

const log = createDebug('soat:model-routes');

/**
 * What usage metering needs to price a completion: which provider instance
 * answered, its slug, and the model name it answered as.
 *
 * `PriceBook` and `UsageEvent` are keyed by `(ai_provider_id, model)`, so a
 * routed completion must be attributed to the target that actually served —
 * never to the route.
 */
export type CompletionAttribution = {
  provider: string;
  modelName: string;
  aiProviderDbId: number;
};

/**
 * Reads back which target served, from the composite model's routing metadata.
 *
 * A composite cannot know its serving target up front — that is the one real
 * cost of routing internal completions, whose metering paths resolve
 * attribution *before* the call. Returns `null` when the model is not routed or
 * when nothing served (every target failed), leaving the caller's pre-call
 * attribution in place.
 */
export const readServedTargetAttribution = async (args: {
  model: LanguageModel;
}): Promise<CompletionAttribution | null> => {
  const routing = readRoutingMetadata(args.model);
  if (!routing || routing.target_index === null) return null;

  // The serving attempt is the last one recorded without an error class: a
  // failed attempt always carries one, and `target_index` is only set on success.
  const served = [...routing.attempts].reverse().find((attempt) => {
    return (
      attempt.target_index === routing.target_index &&
      attempt.error_class === undefined
    );
  });
  /* istanbul ignore next -- `target_index` is only assigned alongside a
     success attempt, so the two cannot disagree. */
  if (!served) return null;

  const provider = await db.AiProvider.findOne({
    where: { publicId: served.ai_provider_id },
    attributes: ['id', 'provider'],
  });
  /* istanbul ignore next -- the provider was resolved to build this target. */
  if (!provider) return null;

  log(
    'readServedTargetAttribution: route=%s target=%d model=%s',
    routing.route_id,
    routing.target_index,
    served.model
  );

  return {
    provider: provider.provider,
    modelName: served.model,
    aiProviderDbId: (provider as unknown as { id: number }).id,
  };
};

/**
 * The attribution to meter a completion with: the served target when the call
 * went through a route, else the attribution resolved before the call.
 */
export const resolveCompletionAttribution = async (args: {
  model: LanguageModel;
  fallback: CompletionAttribution | null;
}): Promise<CompletionAttribution | null> => {
  const served = await readServedTargetAttribution({ model: args.model });
  return served ?? args.fallback;
};

/**
 * Meters one completion against the provider instance that actually served it —
 * the single metering entry point for every path whose model may be a route
 * composite (chats, discussions, memory extraction and consolidation).
 *
 * Fire-and-forget by construction: resolving a routed call's served target is a
 * database read, and metering must never delay or fail the completion it
 * measures. `recordCompletionUsage` already catches internally, so the `.catch`
 * here only covers that read.
 */
export const meterCompletion = (args: {
  model: LanguageModel;
  /** Attribution resolved before the call; `null` for a route composite. */
  fallback: CompletionAttribution | null;
  source: CompletionUsageSource;
  projectId: number;
  agentId?: number;
  /**
   * Model name to record for a **pinned** call — typically the id the provider
   * echoed back. Ignored for a routed call, which is always recorded on the
   * served target's own model name so `(ai_provider_id, model)` stays a valid
   * `PriceBook` key.
   */
  pinnedModel?: string;
  usage: LanguageModelUsage | undefined;
}): void => {
  void resolveCompletionAttribution({
    model: args.model,
    fallback: args.fallback,
  })
    .then((attribution) => {
      /* istanbul ignore next -- a completion that returned always yields one: a
         routed model records its serving target, a pinned one carries `fallback`. */
      if (!attribution) return;

      void recordCompletionUsage({
        source: args.source,
        projectId: args.projectId,
        ...(args.agentId !== undefined && { agentId: args.agentId }),
        provider: attribution.provider,
        aiProviderId: attribution.aiProviderDbId,
        model: args.fallback
          ? (args.pinnedModel ?? attribution.modelName)
          : attribution.modelName,
        usage: args.usage,
      });
    })
    .catch(() => {});
};
