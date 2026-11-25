/**
 * The model each model-backed scorer grades a run under (`scorer_models`),
 * resolved once at run start like `pinDeciderVersions`, so a change of the
 * project's default route, a provider's default model or the deployment's
 * embedding model reaches only runs created after it.
 */
import createDebug from 'debug';

import {
  type EmbeddingModelChoice,
  findConfiguredEmbeddingModel,
  isEmbeddingProvider,
} from './embedding';
import { EMBEDDING_SCORER_TYPE } from './evaluationEmbeddingScorer';
import {
  JUDGE_SCORER_TYPE,
  scorerOutcomeKey,
} from './evaluationScorerValidation';
import { findProjectDefaultModelRouteId } from './modelRouteDefaults';
import { isPlainObject } from './plainObject';
import { aiProviderReferences } from './resourceReferences';

const log = createDebug('soat:evaluations');

export type ScorerModelPin =
  | { ai_provider_id: string; model: string }
  | { model_route_id: string }
  | { embedding_provider: EmbeddingModelChoice['provider']; model: string };

/** Scorer name → pin; null when the run pins no model. */
export type ScorerModels = Record<string, ScorerModelPin>;

/** What a judge resolves its model through, from its pin or its config. */
export type JudgeBinding = {
  aiProviderId: string | null;
  model: string | null;
  modelRouteId: string | null;
};

const stringOf = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

const pinJudge = async (args: {
  scorer: Record<string, unknown>;
  projectId: number;
}): Promise<ScorerModelPin | null> => {
  const aiProviderId = stringOf(args.scorer.ai_provider_id);
  if (aiProviderId === null) {
    const routeId = await findProjectDefaultModelRouteId({
      projectId: args.projectId,
    });
    return routeId ? { model_route_id: routeId } : null;
  }
  const model = stringOf(args.scorer.model);
  if (model !== null) return { ai_provider_id: aiProviderId, model };
  // A provider the project cannot reach pins nothing: the judge call names it.
  const provider = await aiProviderReferences.find({
    id: aiProviderId,
    projectId: args.projectId,
    reach: 'shares',
  });
  return provider
    ? { ai_provider_id: aiProviderId, model: provider.defaultModel }
    : null;
};

const pinEmbedding = (): ScorerModelPin | null => {
  const configured = findConfiguredEmbeddingModel();
  return configured
    ? { embedding_provider: configured.provider, model: configured.model }
    : null;
};

export const pinScorerModels = async (args: {
  scorers: unknown;
  projectId: number;
}): Promise<ScorerModels | null> => {
  if (!Array.isArray(args.scorers)) return null;
  const pins: ScorerModels = {};
  for (const scorer of args.scorers) {
    if (!isPlainObject(scorer)) continue;
    const pin =
      scorer.type === JUDGE_SCORER_TYPE
        ? await pinJudge({ scorer, projectId: args.projectId })
        : scorer.type === EMBEDDING_SCORER_TYPE
          ? pinEmbedding()
          : null;
    if (pin) pins[scorerOutcomeKey(scorer)] = pin;
  }
  log('pinScorerModels: projectId=%d pins=%o', args.projectId, pins);
  return Object.keys(pins).length === 0 ? null : pins;
};

const readPin = (pin: Record<string, unknown>): ScorerModelPin | null => {
  const route = stringOf(pin.model_route_id);
  if (route !== null) return { model_route_id: route };
  const model = stringOf(pin.model);
  if (model === null) return null;
  const provider = stringOf(pin.ai_provider_id);
  if (provider !== null) return { ai_provider_id: provider, model };
  const embedding = stringOf(pin.embedding_provider);
  return embedding !== null && isEmbeddingProvider(embedding)
    ? { embedding_provider: embedding, model }
    : null;
};

/** The stored column, narrowed: an entry of no known shape pins nothing. */
export const readScorerModels = (stored: unknown): ScorerModels | null => {
  if (!isPlainObject(stored)) return null;
  const pins: ScorerModels = {};
  for (const [name, pin] of Object.entries(stored)) {
    const read = isPlainObject(pin) ? readPin(pin) : null;
    if (read) pins[name] = read;
  }
  return Object.keys(pins).length === 0 ? null : pins;
};

/** The judge's binding: its pin when the run has one, else its config. */
export const judgeBindingOf = (args: {
  scorer: Record<string, unknown>;
  pin: ScorerModelPin | undefined;
}): JudgeBinding => {
  const { pin } = args;
  if (pin && 'model_route_id' in pin) {
    return {
      aiProviderId: null,
      model: null,
      modelRouteId: pin.model_route_id,
    };
  }
  if (pin && 'ai_provider_id' in pin) {
    return {
      aiProviderId: pin.ai_provider_id,
      model: pin.model,
      modelRouteId: null,
    };
  }
  return {
    aiProviderId: stringOf(args.scorer.ai_provider_id),
    model: stringOf(args.scorer.model),
    modelRouteId: null,
  };
};

/** The embedding model an embedding scorer's pin names, if any. */
export const embeddingChoiceOf = (
  pin: ScorerModelPin | undefined
): EmbeddingModelChoice | undefined => {
  return pin && 'embedding_provider' in pin
    ? { provider: pin.embedding_provider, model: pin.model }
    : undefined;
};
