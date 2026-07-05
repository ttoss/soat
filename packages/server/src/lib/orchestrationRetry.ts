import createDebug from 'debug';

import { DomainError } from '../errors';
import type { OrchestrationNode, RetryBackoffStrategy } from './orchestrations';

const log = createDebug('soat:orchestrations');

const MAX_ALLOWED_ATTEMPTS = 20;
const DEFAULT_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 300_000; // 5 minutes

export type ResolvedRetryPolicy = {
  maxAttempts: number;
  strategy: RetryBackoffStrategy;
  delayMs: number;
  maxDelayMs: number;
};

/**
 * Resolves a node's retry policy, applying defaults and clamping to safe bounds.
 * When no policy is configured the result is `maxAttempts: 1` — a single
 * attempt, i.e. today's fail-fast behaviour.
 */
export const resolveRetryPolicy = (
  node: OrchestrationNode
): ResolvedRetryPolicy => {
  const retry = node.retry ?? {};
  const backoff = retry.backoff ?? {};

  const maxAttempts = Math.min(
    Math.max(Math.floor(retry.maxAttempts ?? 1), 1),
    MAX_ALLOWED_ATTEMPTS
  );
  const delayMs = Math.max(backoff.delayMs ?? DEFAULT_DELAY_MS, 0);
  const maxDelayMs = Math.max(
    backoff.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    delayMs
  );
  const strategy: RetryBackoffStrategy =
    backoff.strategy === 'exponential' ? 'exponential' : 'fixed';

  return { maxAttempts, strategy, delayMs, maxDelayMs };
};

/**
 * Classifies whether a thrown error is worth retrying. Transient failures —
 * unexpected/infrastructure errors (network, timeouts, provider SDK throws,
 * which surface as non-`DomainError`s) and upstream `5xx` `DomainError`s — are
 * retriable. Deliberate business errors with a `4xx` status (validation, not
 * found, conflict) are terminal: retrying cannot change the outcome.
 */
export const isRetriableError = (error: unknown): boolean => {
  if (error instanceof DomainError) {
    return error.httpStatus >= 500;
  }
  return true;
};

/**
 * The backoff delay before the next attempt. `attempt` is the 1-based number of
 * the attempt that just failed. `fixed` returns `delayMs`; `exponential` doubles
 * per prior attempt (`delayMs * 2^(attempt-1)`), capped at `maxDelayMs`.
 */
export const backoffMs = (args: {
  policy: ResolvedRetryPolicy;
  attempt: number;
}): number => {
  const { policy, attempt } = args;
  const exponent = Math.max(attempt - 1, 0);
  const raw =
    policy.strategy === 'exponential'
      ? policy.delayMs * 2 ** exponent
      : policy.delayMs;
  const delay = Math.min(raw, policy.maxDelayMs);
  log(
    'backoffMs: strategy=%s attempt=%d delay=%d',
    policy.strategy,
    attempt,
    delay
  );
  return delay;
};
