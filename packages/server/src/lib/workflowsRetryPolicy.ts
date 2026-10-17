import { isPlainObject } from './plainObject';
import type { ValidationProblem } from './validationProblems';

/**
 * Optional retry policy on a state's `on_enter`, covering the dispatch's
 * **execution** failures (a tool/agent error, an orchestration run that ends
 * `failed`) — never `on_complete` routing. The delay before attempt `n` is
 * `backoffSeconds * backoffMultiplier^(n - 2)`. Attempts respect the same
 * cancellation-on-exit token a single attempt does: if the task leaves the state
 * between attempts, the remaining ones are abandoned. `on_failure` / the parked
 * `automation_status: 'failed'` fire only after the last attempt, so declaring
 * no `retry` means a single attempt.
 */
export type RetryPolicy = {
  maxAttempts: number;
  backoffSeconds?: number;
  backoffMultiplier?: number;
};

// The attempts run inside the detached automation promise, so an unbounded
// `max_attempts` or backoff would hold a card mid-dispatch for as long as the
// author asked. Both caps are generous for the transient-flake case.
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

/**
 * Every problem with a state's `on_enter.retry` block; a null/absent policy
 * has none. Messages name the wire (snake_case) field so an author reads back
 * the key they wrote.
 */
export const retryPolicyProblems = (args: {
  stateName: string;
  path: string;
  retry: RetryPolicy | null | undefined;
}): ValidationProblem[] => {
  const { retry, stateName, path } = args;
  if (retry == null) return [];
  if (!isPlainObject(retry)) {
    return [
      {
        code: 'INVALID_TYPE',
        path,
        message: `State '${stateName}' on_enter retry must be an object.`,
      },
    ];
  }
  const problems: ValidationProblem[] = [];
  if (
    !Number.isInteger(retry.maxAttempts) ||
    !isNumberInRange({
      value: retry.maxAttempts,
      min: 1,
      max: MAX_RETRY_ATTEMPTS,
    })
  ) {
    problems.push({
      code: 'INVALID_VALUE',
      path: `${path}.max_attempts`,
      message: `State '${stateName}' retry max_attempts must be an integer between 1 and ${MAX_RETRY_ATTEMPTS}.`,
    });
  }
  if (
    retry.backoffSeconds != null &&
    !isNumberInRange({
      value: retry.backoffSeconds,
      min: 0,
      max: MAX_BACKOFF_SECONDS,
    })
  ) {
    problems.push({
      code: 'INVALID_VALUE',
      path: `${path}.backoff_seconds`,
      message: `State '${stateName}' retry backoff_seconds must be a number between 0 and ${MAX_BACKOFF_SECONDS}.`,
    });
  }
  if (
    retry.backoffMultiplier != null &&
    !isNumberInRange({
      value: retry.backoffMultiplier,
      min: 1,
      max: MAX_BACKOFF_MULTIPLIER,
    })
  ) {
    problems.push({
      code: 'INVALID_VALUE',
      path: `${path}.backoff_multiplier`,
      message: `State '${stateName}' retry backoff_multiplier must be a number between 1 and ${MAX_BACKOFF_MULTIPLIER}.`,
    });
  }
  return problems;
};
