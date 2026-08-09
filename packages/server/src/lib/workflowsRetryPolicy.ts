import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

/**
 * Optional retry policy on a state's `on_enter`, covering the dispatch's
 * **execution** failures (a tool/agent error, an orchestration run that ends
 * `failed`) — never `on_complete` routing. The delay before attempt `n` is
 * `backoffSeconds * backoffMultiplier^(n - 2)`. Attempts respect the same
 * cancellation-on-exit token a single attempt does: if the task leaves the state
 * between attempts, the remaining ones are abandoned. `on_failure` / the parked
 * `automation_status: 'failed'` fire only after the last attempt, so declaring
 * no `retry` is exactly the pre-#822 behavior.
 */
export type RetryPolicy = {
  maxAttempts: number;
  backoffSeconds?: number;
  backoffMultiplier?: number;
};

// Bounds on a retry policy. The attempts run inside the detached automation
// promise, so an unbounded `max_attempts` (or a multi-hour backoff) would hold a
// card mid-dispatch for as long as the author asked for. Both caps are generous
// for the transient-flake case the primitive exists for and reject the runaway
// shapes.
const MAX_RETRY_ATTEMPTS = 10;
const MAX_BACKOFF_SECONDS = 3600;
const MAX_BACKOFF_MULTIPLIER = 10;

const isNumberInRange = (args: {
  value: unknown;
  min: number;
  max: number;
}): boolean => {
  return (
    typeof args.value === 'number' &&
    Number.isFinite(args.value) &&
    args.value >= args.min &&
    args.value <= args.max
  );
};

const fail = (message: string, stateName: string): never => {
  throw new DomainError('WORKFLOW_VALIDATION_FAILED', message, {
    state: stateName,
  });
};

/**
 * Validates a state's `on_enter.retry` block. Error messages name the wire
 * (snake_case) field so an author reads back the key they wrote. Throws
 * `WORKFLOW_VALIDATION_FAILED`; a null/absent policy is valid.
 */
export const assertRetryPolicyValid = (args: {
  stateName: string;
  retry: RetryPolicy | null | undefined;
}): void => {
  const { retry, stateName } = args;
  if (retry == null) return;
  if (!isPlainObject(retry)) {
    fail(`State '${stateName}' on_enter retry must be an object.`, stateName);
    return;
  }
  if (
    !Number.isInteger(retry.maxAttempts) ||
    !isNumberInRange({
      value: retry.maxAttempts,
      min: 1,
      max: MAX_RETRY_ATTEMPTS,
    })
  ) {
    fail(
      `State '${stateName}' retry max_attempts must be an integer between 1 and ${MAX_RETRY_ATTEMPTS}.`,
      stateName
    );
  }
  if (
    retry.backoffSeconds != null &&
    !isNumberInRange({
      value: retry.backoffSeconds,
      min: 0,
      max: MAX_BACKOFF_SECONDS,
    })
  ) {
    fail(
      `State '${stateName}' retry backoff_seconds must be a number between 0 and ${MAX_BACKOFF_SECONDS}.`,
      stateName
    );
  }
  if (
    retry.backoffMultiplier != null &&
    !isNumberInRange({
      value: retry.backoffMultiplier,
      min: 1,
      max: MAX_BACKOFF_MULTIPLIER,
    })
  ) {
    fail(
      `State '${stateName}' retry backoff_multiplier must be a number between 1 and ${MAX_BACKOFF_MULTIPLIER}.`,
      stateName
    );
  }
};
