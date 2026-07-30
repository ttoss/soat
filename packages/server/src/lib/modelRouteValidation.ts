import {
  MODEL_ROUTE_ERROR_CLASSES,
  type ModelRouteErrorClass,
} from './modelRouteErrors';

/**
 * A route target, stored and exposed in the wire (snake_case) shape.
 * `timeout_seconds` omitted means no per-target deadline; `max_retries`
 * omitted means the target is tried once and then failover moves on.
 */
export type ModelRouteTarget = {
  ai_provider_id: string;
  model: string;
  timeout_seconds?: number;
  max_retries?: number;
};

const TARGET_FIELDS = new Set([
  'ai_provider_id',
  'model',
  'timeout_seconds',
  'max_retries',
]);

export const DEFAULT_TARGET_MAX_RETRIES = 0;
export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_SECONDS = 60;

/**
 * Total attempts a single route may issue across all its targets. Enforced at
 * create/update time rather than clamped at runtime: a runtime clamp silently
 * truncates configured behavior, while a rejection is deterministic and the
 * operator sees it immediately.
 */
export const MAX_MODEL_ROUTE_ATTEMPTS = 10;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
};

const isNonNegativeInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
};

/** Attempts a target may issue: the first call plus its retries. */
export const targetAttempts = (target: ModelRouteTarget): number => {
  return 1 + (target.max_retries ?? DEFAULT_TARGET_MAX_RETRIES);
};

export const modelRouteTotalAttempts = (
  targets: readonly ModelRouteTarget[]
): number => {
  return targets.reduce((total, target) => {
    return total + targetAttempts(target);
  }, 0);
};

const validateTargetValues = (args: {
  entry: Record<string, unknown>;
  at: string;
}): string | null => {
  const { entry, at } = args;

  if (typeof entry.ai_provider_id !== 'string' || entry.ai_provider_id === '') {
    return `${at}.ai_provider_id is required and must be a string.`;
  }
  if (typeof entry.model !== 'string' || entry.model === '') {
    return `${at}.model is required and must be a string.`;
  }
  if (
    entry.timeout_seconds !== undefined &&
    !isPositiveInteger(entry.timeout_seconds)
  ) {
    return `${at}.timeout_seconds must be a positive integer.`;
  }
  if (
    entry.max_retries !== undefined &&
    !isNonNegativeInteger(entry.max_retries)
  ) {
    return `${at}.max_retries must be an integer greater than or equal to 0.`;
  }

  return null;
};

const validateTargetEntry = (args: {
  entry: unknown;
  index: number;
}): string | null => {
  const { entry, index } = args;
  const at = `targets[${index}]`;

  if (!isPlainObject(entry)) {
    return `${at} must be an object.`;
  }

  for (const key of Object.keys(entry)) {
    if (!TARGET_FIELDS.has(key)) {
      return `${at} has unknown field '${key}'.`;
    }
  }

  return validateTargetValues({ entry, at });
};

/**
 * Validates the ordered target list: at least one entry, known fields only,
 * and a bounded total attempt count. Returns a message on the first problem or
 * `null` when valid. Pure — the single source of truth shared by the REST
 * handlers and the formation module.
 */
export const validateModelRouteTargets = (targets: unknown): string | null => {
  if (!Array.isArray(targets) || targets.length === 0) {
    return 'targets must be a non-empty array.';
  }

  for (const [index, entry] of targets.entries()) {
    const error = validateTargetEntry({ entry, index });
    if (error) return error;
  }

  const total = modelRouteTotalAttempts(targets as ModelRouteTarget[]);
  if (total > MAX_MODEL_ROUTE_ATTEMPTS) {
    return `targets would allow ${total} total attempts (sum of 1 + max_retries per target); the maximum is ${MAX_MODEL_ROUTE_ATTEMPTS}.`;
  }

  return null;
};

export const validateModelRouteRetryOn = (retryOn: unknown): string | null => {
  if (!Array.isArray(retryOn) || retryOn.length === 0) {
    return `retry_on must be a non-empty array containing any of ${MODEL_ROUTE_ERROR_CLASSES.join(' / ')}.`;
  }
  for (const entry of retryOn) {
    if (!MODEL_ROUTE_ERROR_CLASSES.includes(entry as ModelRouteErrorClass)) {
      return `retry_on contains unknown class '${String(entry)}'; allowed: ${MODEL_ROUTE_ERROR_CLASSES.join(' / ')}.`;
    }
  }
  return null;
};

export const validateModelRouteBreakerConfig = (args: {
  failureThreshold: unknown;
  cooldownSeconds: unknown;
}): string | null => {
  if (!isPositiveInteger(args.failureThreshold)) {
    return 'failure_threshold must be a positive integer.';
  }
  if (!isPositiveInteger(args.cooldownSeconds)) {
    return 'cooldown_seconds must be a positive integer.';
  }
  return null;
};

/** Whether a binding field names something — `null`/`''` both mean "unset". */
export const hasModelBinding = (value: unknown): boolean => {
  return value != null && value !== '';
};

/**
 * A consumer resolves its completion model through **at most one** of a pinned
 * provider (`ai_provider_id`, optionally with `model`) or a `model_route_id`.
 * Naming neither means "inherit the project's `default_model_route_id`"; that
 * the project actually has one is a database fact, so it is checked by
 * `assertModelBindingResolvable` rather than here (this function stays pure).
 *
 * Enforcing exclusivity — rather than letting a route override a pin — keeps
 * `ai_provider_id` from lingering as permanently dead config with the
 * precedence rule living in prose. `model` may not accompany a route, named or
 * inherited, because each target names its own.
 *
 * Callers pass the **effective** post-write state (for a partial update: the
 * incoming value where provided, the stored value otherwise). Returns a message
 * or `null` when valid.
 */
export const validateModelRouteExclusivity = (args: {
  modelRouteId: unknown;
  aiProviderId: unknown;
  model: unknown;
}): string | null => {
  const hasRoute = hasModelBinding(args.modelRouteId);
  const hasProvider = hasModelBinding(args.aiProviderId);

  if (hasRoute && hasProvider) {
    return 'model_route_id and ai_provider_id are mutually exclusive; set ai_provider_id to null in the same request to switch to a model route.';
  }
  if (hasRoute && hasModelBinding(args.model)) {
    return 'model cannot be combined with model_route_id; each route target names its own model.';
  }
  if (!hasProvider && hasModelBinding(args.model)) {
    return 'model requires an ai_provider_id; without one the model comes from the inherited project default route, whose targets name their own models.';
  }

  return null;
};
