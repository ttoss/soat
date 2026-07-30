import createDebug from 'debug';

const log = createDebug('soat:model-routes:breaker');

/**
 * Provider health is a hot-path hint with a half-life of seconds, so breaker
 * state lives in process memory per node rather than in the database: a
 * persisted counter would add a write on every completion and a read before
 * every target attempt for a fact that is stale by the time it commits. A cold
 * node re-learns an outage within `failure_threshold` requests. Multi-node
 * deployments may briefly disagree about a target's health; that is accepted.
 *
 * State is keyed by `(ai_provider_db_id, model)` and therefore **shared across
 * routes**: a dead backend is dead regardless of which route noticed it. The
 * *counter* is shared; the *policy* (`failure_threshold` / `cooldown_seconds`)
 * comes from the route evaluating the target, so two routes may legitimately
 * hold different opinions about when to start skipping.
 */
type BreakerState = {
  consecutiveFailures: number;
  lastFailureAt: number;
};

const breakerStates = new Map<string, BreakerState>();

export const modelRouteBreakerKey = (args: {
  aiProviderDbId: number;
  model: string;
}): string => {
  return `${args.aiProviderDbId}:${args.model}`;
};

/**
 * True when the target has failed at least `failureThreshold` consecutive times
 * and the last failure is still inside `cooldownSeconds`. Once the cooldown
 * elapses the target is probed again (the counter is left in place, so a single
 * further failure re-opens the breaker).
 */
export const isTargetTripped = (args: {
  key: string;
  failureThreshold: number;
  cooldownSeconds: number;
  now?: number;
}): boolean => {
  const state = breakerStates.get(args.key);
  if (!state) return false;
  if (state.consecutiveFailures < args.failureThreshold) return false;
  const now = args.now ?? Date.now();
  return now - state.lastFailureAt < args.cooldownSeconds * 1000;
};

export const recordTargetFailure = (args: {
  key: string;
  now?: number;
}): void => {
  const state = breakerStates.get(args.key) ?? {
    consecutiveFailures: 0,
    lastFailureAt: 0,
  };
  state.consecutiveFailures += 1;
  state.lastFailureAt = args.now ?? Date.now();
  breakerStates.set(args.key, state);
  log(
    'recordTargetFailure: key=%s consecutiveFailures=%d',
    args.key,
    state.consecutiveFailures
  );
};

export const recordTargetSuccess = (args: { key: string }): void => {
  if (breakerStates.delete(args.key)) {
    log('recordTargetSuccess: key=%s reset', args.key);
  }
};

/** Test seam: drops all in-process breaker state. */
export const resetModelRouteBreakers = (): void => {
  breakerStates.clear();
};
