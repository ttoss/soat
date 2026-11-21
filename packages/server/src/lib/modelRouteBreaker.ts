import createDebug from 'debug';

const log = createDebug('soat:model-routes:breaker');

/**
 * Provider health is a hot-path hint with a half-life of seconds, so breaker
 * state lives in process memory per node: a persisted counter would add a write
 * per completion and a read per attempt for a fact that is stale by the time it
 * commits. A cold node re-learns an outage within `failure_threshold` requests,
 * and multi-node deployments may briefly disagree — accepted.
 *
 * Keyed by `(consuming project, ai_provider_db_id, model)`: shared across one
 * project's routes, never across projects, because one provider may serve many
 * projects and one project's failures (its quota, its inputs) must not fail
 * another over. The *policy* comes from the route evaluating the target.
 */
type BreakerState = {
  consecutiveFailures: number;
  lastFailureAt: number;
};

const breakerStates = new Map<string, BreakerState>();

export type BreakerTarget = {
  /** The project consuming the route, not the provider's owner. */
  projectId: number;
  aiProviderDbId: number;
  model: string;
};

const breakerKey = (target: BreakerTarget): string => {
  return `${target.projectId}:${target.aiProviderDbId}:${target.model}`;
};

/**
 * True when the target has failed at least `failureThreshold` consecutive times
 * and the last failure is still inside `cooldownSeconds`. Once the cooldown
 * elapses the target is probed again (the counter is left in place, so a single
 * further failure re-opens the breaker).
 */
export const isTargetTripped = (args: {
  target: BreakerTarget;
  failureThreshold: number;
  cooldownSeconds: number;
  now?: number;
}): boolean => {
  const state = breakerStates.get(breakerKey(args.target));
  if (!state) return false;
  if (state.consecutiveFailures < args.failureThreshold) return false;
  const now = args.now ?? Date.now();
  return now - state.lastFailureAt < args.cooldownSeconds * 1000;
};

export const recordTargetFailure = (args: {
  target: BreakerTarget;
  now?: number;
}): void => {
  const key = breakerKey(args.target);
  const state = breakerStates.get(key) ?? {
    consecutiveFailures: 0,
    lastFailureAt: 0,
  };
  state.consecutiveFailures += 1;
  state.lastFailureAt = args.now ?? Date.now();
  breakerStates.set(key, state);
  log(
    'recordTargetFailure: key=%s consecutiveFailures=%d',
    key,
    state.consecutiveFailures
  );
};

export const recordTargetSuccess = (args: { target: BreakerTarget }): void => {
  const key = breakerKey(args.target);
  if (breakerStates.delete(key)) {
    log('recordTargetSuccess: key=%s reset', key);
  }
};

/** Test seam: drops all in-process breaker state. */
export const resetModelRouteBreakers = (): void => {
  breakerStates.clear();
};
