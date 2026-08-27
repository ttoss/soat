/**
 * The `LanguageModel` an agent's generation runs on: its own model route → its
 * pinned provider → the project default route.
 *
 * Implemented twice before, for a fresh turn and a resumed one, differing only
 * in how they report failure — so the chain lives here once and each caller
 * keeps its own failure mode (the fresh path throws `AI_PROVIDER_NOT_FOUND`,
 * the resumed path reports the generation unrecoverable).
 *
 * Separate from `agentModel.ts` because `modelRoutes` reaches `buildModel`
 * through `modelRouteResolution`, so hosting the chain there would close a cycle.
 */
import type { LanguageModel } from 'ai';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import type { TypedAgent } from './agentGenerationTypes';
import { buildModel } from './agentModel';
import {
  buildRoutedModel,
  resolveConsumerModelRoute,
  ROUTED_PROVIDER_LABEL,
} from './modelRoutes';

/**
 * Why no model could be resolved, for a caller that reports rather than throws.
 *
 * - `no_binding` — the agent has neither a route nor a pinned provider. The
 *   write-time guards make this unreachable through any write path.
 * - `provider_unresolvable` — the pinned provider row or its secret is gone
 *   (a delete racing the agent load).
 */
export type AgentModelResolutionFailure =
  'no_binding' | 'provider_unresolvable';

export type AgentModelResolution =
  | { model: LanguageModel; provider: string; failure?: undefined }
  | {
      model?: undefined;
      provider?: undefined;
      failure: AgentModelResolutionFailure;
    };

export const resolveAgentModel = async (
  typedAgent: TypedAgent
): Promise<AgentModelResolution> => {
  // `resolveConsumerModelRoute` returns null as soon as a pin is present, so a
  // project-wide default can never override a deliberate binding.
  const route = await resolveConsumerModelRoute({
    projectId: typedAgent.project.id as number,
    modelRouteId: typedAgent.modelRoute?.publicId,
    aiProviderId: typedAgent.aiProvider?.publicId,
  });
  if (route) {
    return {
      model: await buildRoutedModel({ route }),
      provider: ROUTED_PROVIDER_LABEL,
    };
  }

  // The write-time guards guarantee a pinned provider once neither a route nor a
  // project default resolves; this only fires if a row violates them (never
  // reachable through a write path).
  /* istanbul ignore next */
  if (!typedAgent.aiProvider) return { failure: 'no_binding' };

  const resolved = await resolveAiProviderSecret({
    aiProviderId: typedAgent.aiProvider.publicId,
  });

  // TOCTOU guard: reachable only if the provider row is deleted between the
  // agent load and this lookup.
  /* istanbul ignore next */
  if (!resolved) return { failure: 'provider_unresolvable' };

  return {
    model: await buildModel({
      provider: resolved.provider,
      secretValue: resolved.secretValue,
      model: typedAgent.model ?? resolved.defaultModel,
      baseUrl: resolved.baseUrl,
      config: resolved.config as Record<string, unknown> | undefined,
    }),
    provider: resolved.provider,
  };
};
