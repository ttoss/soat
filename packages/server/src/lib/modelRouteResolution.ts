import type { LanguageModel } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { buildModel } from './agentModel';
import { resolveAiProviderSecret } from './aiProviders';
import { createRoutedModel, type RoutedTarget } from './modelRouteExecutor';
import {
  mapModelRouteConfig,
  type ModelRouteConfig,
  type ModelRouteInstance,
} from './modelRouteMapper';
import {
  DEFAULT_TARGET_MAX_RETRIES,
  type ModelRouteTarget,
} from './modelRouteValidation';

const log = createDebug('soat:model-routes');

// ── Resolution ───────────────────────────────────────────────────────────

/**
 * Resolves a route's public id to the internal id, scoped to the project that
 * will reference it — a consumer can only route through its own project's
 * routes.
 */
export const resolveModelRouteDbId = async (args: {
  modelRouteId: string;
  projectId: number;
}): Promise<number> => {
  const route = await db.ModelRoute.findOne({
    where: { publicId: args.modelRouteId, projectId: args.projectId },
    attributes: ['id'],
  });
  if (!route) {
    throw new DomainError(
      'MODEL_ROUTE_NOT_FOUND',
      `Model route '${args.modelRouteId}' not found in this project.`
    );
  }
  return (route as unknown as { id: number }).id;
};

/** Loads the runtime config for a route referenced by its public id. */
export const loadModelRouteConfig = async (args: {
  modelRouteId: string;
  projectId?: number;
}): Promise<ModelRouteConfig> => {
  const where: Record<string, unknown> = { publicId: args.modelRouteId };
  if (args.projectId !== undefined) where.projectId = args.projectId;

  const route = await db.ModelRoute.findOne({ where });
  if (!route) {
    throw new DomainError(
      'MODEL_ROUTE_NOT_FOUND',
      `Model route '${args.modelRouteId}' not found.`
    );
  }
  return mapModelRouteConfig(route as ModelRouteInstance);
};

const asInnerModel = (
  model: LanguageModel,
  label: string
): RoutedTarget['model'] => {
  if (
    typeof model === 'object' &&
    model !== null &&
    model.specificationVersion === 'v4'
  ) {
    return model;
  }
  /* istanbul ignore next -- every provider builder returns a v4 model object;
     this guard only exists so the narrowing is real rather than asserted. */
  throw new DomainError(
    'AI_PROVIDER_ERROR',
    `Model route target ${label} produced an unsupported model interface.`
  );
};

const buildRoutedTarget = async (args: {
  target: ModelRouteTarget;
  index: number;
  routeId: string;
}): Promise<RoutedTarget> => {
  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.target.ai_provider_id,
  });
  if (!resolved) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.target.ai_provider_id}' referenced by model route '${args.routeId}' could not be resolved.`
    );
  }

  return {
    index: args.index,
    aiProviderId: args.target.ai_provider_id,
    aiProviderDbId: resolved.id,
    modelName: args.target.model,
    timeoutMs:
      args.target.timeout_seconds != null
        ? args.target.timeout_seconds * 1000
        : null,
    maxRetries: args.target.max_retries ?? DEFAULT_TARGET_MAX_RETRIES,
    model: asInnerModel(
      buildModel({
        provider: resolved.provider,
        secretValue: resolved.secretValue,
        model: args.target.model,
        baseUrl: resolved.baseUrl,
        config: resolved.config as Record<string, unknown> | undefined,
      }),
      `${args.index}`
    ),
  };
};

/**
 * Builds the composite `LanguageModel` for a route. Callers keep receiving a
 * plain `LanguageModel` and are otherwise untouched — the fallback happens
 * inside the model, per LLM call.
 */
export const buildRoutedModel = async (args: {
  route: ModelRouteConfig;
}): Promise<LanguageModel> => {
  const targets = await Promise.all(
    args.route.targets.map((target, index) => {
      return buildRoutedTarget({ target, index, routeId: args.route.id });
    })
  );

  log(
    'buildRoutedModel: route=%s targets=%d retryOn=%o',
    args.route.id,
    targets.length,
    args.route.retry_on
  );

  return createRoutedModel({
    routeId: args.route.id,
    retryOn: args.route.retry_on,
    failureThreshold: args.route.failure_threshold,
    cooldownSeconds: args.route.cooldown_seconds,
    targets,
  });
};
