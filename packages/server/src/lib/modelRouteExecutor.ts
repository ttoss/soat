import type { LanguageModel } from 'ai';
import createDebug from 'debug';

import {
  isTargetTripped,
  modelRouteBreakerKey,
  recordTargetFailure,
  recordTargetSuccess,
} from './modelRouteBreaker';
import {
  classifyModelRouteError,
  type ModelRouteErrorClass,
} from './modelRouteErrors';

const log = createDebug('soat:model-routes:executor');

/**
 * `provider` reported by the composite model. Distinct from any real provider
 * slug, so a caller inspecting the model sees the route rather than whichever
 * target happens to serve.
 */
export const ROUTED_PROVIDER_LABEL = 'soat.model-route';

// The provider-level model interface, derived from the SDK's own union instead
// of importing @ai-sdk/provider directly — the composite must implement exactly
// what `buildModel`'s products implement.
type RoutedInnerModel = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type RoutedCallOptions = Parameters<RoutedInnerModel['doGenerate']>[0];
type RoutedGenerateResult = Awaited<ReturnType<RoutedInnerModel['doGenerate']>>;
type RoutedStreamResult = Awaited<ReturnType<RoutedInnerModel['doStream']>>;

export type RoutedTarget = {
  /** Position in the route's `targets` array — the ordered priority. */
  index: number;
  /** Public id of the target's AI provider, reported in routing metadata. */
  aiProviderId: string;
  /** Internal provider id — half of the shared circuit-breaker key. */
  aiProviderDbId: number;
  modelName: string;
  timeoutMs: number | null;
  maxRetries: number;
  model: RoutedInnerModel;
};

export type RoutingAttempt = {
  target_index: number;
  ai_provider_id: string;
  model: string;
  error_class?: ModelRouteErrorClass;
};

/**
 * What the route actually did, stamped onto the Generation's `metadata` so a
 * trace explains which provider answered. Accumulates across every LLM call of
 * a multi-step run, so `attempts` is the full per-generation history and
 * `target_index` names the target that served the most recent call.
 */
export type RoutingMetadata = {
  route_id: string;
  target_index: number | null;
  attempts: RoutingAttempt[];
  fallbacks: number;
};

export type RoutedModelSpec = {
  routeId: string;
  retryOn: readonly ModelRouteErrorClass[];
  failureThreshold: number;
  cooldownSeconds: number;
  targets: RoutedTarget[];
};

// Identifies composite models so a caller can (a) turn the SDK's own retry loop
// off — the route config is the only retry authority — and (b) read back what
// the route did. A WeakMap keeps the marker off the object the SDK inspects.
const routingByModel = new WeakMap<object, RoutingMetadata>();

export const isRoutedModel = (model: LanguageModel): boolean => {
  return (
    typeof model === 'object' && model !== null && routingByModel.has(model)
  );
};

/**
 * `maxRetries` to pass to `generateText`/`streamText` for this model. The SDK
 * default is 2, which would multiply with the route's own retries (3 × 3 = 9
 * attempts per target during an outage — the exact scenario the caps exist
 * for), so routed calls get 0 and the composite owns every attempt.
 * Non-routed calls get `undefined` and keep the SDK default untouched.
 */
export const routedMaxRetries = (model: LanguageModel): 0 | undefined => {
  return isRoutedModel(model) ? 0 : undefined;
};

export const readRoutingMetadata = (
  model: LanguageModel
): RoutingMetadata | undefined => {
  return typeof model === 'object' && model !== null
    ? routingByModel.get(model)
    : undefined;
};

/**
 * The AI provider that served the model's last call, for a routed model — the
 * target `target_index` names, read off its successful attempt. Null for a
 * model no route composed (the caller falls back to the agent's pinned
 * provider) and for a route that succeeded on no target.
 */
export const routedAiProviderId = (model: LanguageModel): string | null => {
  const routing = readRoutingMetadata(model);
  if (!routing) return null;
  const served = [...routing.attempts].reverse().find((attempt) => {
    return (
      attempt.target_index === routing.target_index &&
      attempt.error_class === undefined
    );
  });
  return served?.ai_provider_id ?? null;
};

/**
 * A per-attempt signal: the target's own timeout composed with the caller's
 * signal. The generation paths already thread `abortSignal` end-to-end, so both
 * must be able to cancel the attempt — but only the timeout is a failover
 * (see `classifyModelRouteError`).
 */
const composeAttemptSignal = (args: {
  callerSignal?: AbortSignal;
  timeoutMs: number | null;
}): AbortSignal | undefined => {
  if (args.timeoutMs == null) return args.callerSignal;
  const timeout = AbortSignal.timeout(args.timeoutMs);
  return args.callerSignal
    ? AbortSignal.any([args.callerSignal, timeout])
    : timeout;
};

/**
 * The targets to try, in order, skipping the ones whose breaker is open. If the
 * breaker would skip *every* target the first one is probed anyway (half-open):
 * refusing to call would turn a transient outage into a hard `cooldown_seconds`
 * outage even after the provider recovered.
 */
const selectTargets = (spec: RoutedModelSpec): RoutedTarget[] => {
  const eligible = spec.targets.filter((target) => {
    return !isTargetTripped({
      key: modelRouteBreakerKey({
        aiProviderDbId: target.aiProviderDbId,
        model: target.modelName,
      }),
      failureThreshold: spec.failureThreshold,
      cooldownSeconds: spec.cooldownSeconds,
    });
  });
  return eligible.length > 0 ? eligible : [spec.targets[0]];
};

const runWithFallback = async <T>(args: {
  spec: RoutedModelSpec;
  routing: RoutingMetadata;
  options: RoutedCallOptions;
  invoke: (invokeArgs: {
    model: RoutedInnerModel;
    options: RoutedCallOptions;
  }) => PromiseLike<T>;
}): Promise<T> => {
  const { spec, routing } = args;
  const targets = selectTargets(spec);
  let targetsTried = 0;
  let lastError: unknown;

  for (const target of targets) {
    targetsTried += 1;
    const breakerKey = modelRouteBreakerKey({
      aiProviderDbId: target.aiProviderDbId,
      model: target.modelName,
    });

    for (let attempt = 0; attempt <= target.maxRetries; attempt += 1) {
      try {
        const result = await args.invoke({
          model: target.model,
          options: {
            ...args.options,
            abortSignal: composeAttemptSignal({
              callerSignal: args.options.abortSignal,
              timeoutMs: target.timeoutMs,
            }),
          },
        });
        recordTargetSuccess({ key: breakerKey });
        routing.attempts.push({
          target_index: target.index,
          ai_provider_id: target.aiProviderId,
          model: target.modelName,
        });
        routing.target_index = target.index;
        routing.fallbacks += targetsTried - 1;
        return result;
      } catch (error) {
        const errorClass = classifyModelRouteError({
          error,
          callerSignal: args.options.abortSignal,
        });
        routing.attempts.push({
          target_index: target.index,
          ai_provider_id: target.aiProviderId,
          model: target.modelName,
          ...(errorClass !== null && { error_class: errorClass }),
        });
        lastError = error;

        log(
          'attempt failed: route=%s target=%d attempt=%d class=%s',
          spec.routeId,
          target.index,
          attempt,
          errorClass ?? 'deterministic'
        );

        // A deterministic rejection fails identically on every target, and a
        // class the route did not opt into is not failover-eligible: both fail
        // fast rather than spending another target's budget.
        if (errorClass === null || !spec.retryOn.includes(errorClass)) {
          routing.fallbacks += targetsTried - 1;
          throw error;
        }

        recordTargetFailure({ key: breakerKey });
      }
    }
  }

  routing.fallbacks += targetsTried - 1;
  throw lastError;
};

/**
 * A composite `LanguageModel` that holds one inner model per route target and
 * delegates with ordered fallback.
 *
 * The failover happens at the **individual LLM call**, not around the caller's
 * `generateText` — agent generation is a multi-step loop whose tools have real
 * side effects (HTTP, MCP, SOAT actions, `write_memory`), so restarting the
 * loop on another provider would re-execute every completed tool call. Failing
 * over one call keeps the earlier steps' tool results in the message history.
 */
export const createRoutedModel = (spec: RoutedModelSpec): LanguageModel => {
  const routing: RoutingMetadata = {
    route_id: spec.routeId,
    target_index: null,
    attempts: [],
    fallbacks: 0,
  };

  const composite: RoutedInnerModel = {
    specificationVersion: 'v4',
    provider: 'soat.model-route',
    modelId: spec.routeId,
    // Deliberately empty: targets may disagree about which URLs they can fetch
    // natively, so the composite claims none and lets the SDK download inputs —
    // the only answer that is correct whichever target ends up serving.
    supportedUrls: {},
    doGenerate: (options) => {
      return runWithFallback<RoutedGenerateResult>({
        spec,
        routing,
        options,
        invoke: ({ model, options: attemptOptions }) => {
          return model.doGenerate(attemptOptions);
        },
      });
    },
    // Before the first token only: replaying a partial stream elsewhere would
    // duplicate tool side effects, re-bill the prefix, and splice two models'
    // outputs into one message.
    doStream: (options) => {
      return runWithFallback<RoutedStreamResult>({
        spec,
        routing,
        options,
        invoke: ({ model, options: attemptOptions }) => {
          return model.doStream(attemptOptions);
        },
      });
    },
  };

  routingByModel.set(composite, routing);

  return composite;
};
