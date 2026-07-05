import { DomainError } from 'src/errors';
import {
  backoffMs,
  isRetriableError,
  resolveRetryPolicy,
} from 'src/lib/orchestrationRetry';
import type { OrchestrationNode } from 'src/lib/orchestrations';

const node = (retry?: OrchestrationNode['retry']): OrchestrationNode => {
  return { id: 'n', type: 'tool', retry };
};

describe('orchestrationRetry', () => {
  describe('resolveRetryPolicy', () => {
    test('defaults to a single attempt (fail-fast) when no policy is set', () => {
      expect(resolveRetryPolicy(node())).toEqual({
        maxAttempts: 1,
        strategy: 'fixed',
        delayMs: 1_000,
        maxDelayMs: 300_000,
      });
    });

    test('honours configured values', () => {
      expect(
        resolveRetryPolicy(
          node({
            maxAttempts: 5,
            backoff: { strategy: 'exponential', delayMs: 2_000, maxDelayMs: 9 },
          })
        )
      ).toEqual({
        maxAttempts: 5,
        strategy: 'exponential',
        // maxDelayMs is floored to delayMs when configured lower.
        delayMs: 2_000,
        maxDelayMs: 2_000,
      });
    });

    test('clamps maxAttempts to [1, 20] and floors delay at 0', () => {
      expect(resolveRetryPolicy(node({ maxAttempts: 999 })).maxAttempts).toBe(
        20
      );
      expect(resolveRetryPolicy(node({ maxAttempts: 0 })).maxAttempts).toBe(1);
      expect(
        resolveRetryPolicy(node({ backoff: { delayMs: -100 } })).delayMs
      ).toBe(0);
    });
  });

  describe('isRetriableError', () => {
    test('retries unexpected (non-DomainError) errors', () => {
      expect(isRetriableError(new Error('socket hang up'))).toBe(true);
      expect(isRetriableError('boom')).toBe(true);
    });

    test('retries 5xx DomainErrors but not 4xx ones', () => {
      expect(
        isRetriableError(new DomainError('ORCHESTRATION_NODE_FAILED', 'x'))
      ).toBe(false); // 422 — terminal
      expect(isRetriableError(new DomainError('RESOURCE_NOT_FOUND', 'x'))).toBe(
        false
      ); // 404 — terminal
      expect(isRetriableError(new DomainError('GENERATION_FAILED', 'x'))).toBe(
        true
      ); // 500 — retriable
    });
  });

  describe('backoffMs', () => {
    test('fixed strategy returns the base delay every attempt', () => {
      const policy = resolveRetryPolicy(node({ backoff: { delayMs: 500 } }));
      expect(backoffMs({ policy, attempt: 1 })).toBe(500);
      expect(backoffMs({ policy, attempt: 4 })).toBe(500);
    });

    test('exponential strategy doubles per prior attempt, capped at maxDelayMs', () => {
      const policy = resolveRetryPolicy(
        node({
          backoff: {
            strategy: 'exponential',
            delayMs: 1_000,
            maxDelayMs: 5_000,
          },
        })
      );
      expect(backoffMs({ policy, attempt: 1 })).toBe(1_000); // 1000 * 2^0
      expect(backoffMs({ policy, attempt: 2 })).toBe(2_000); // 1000 * 2^1
      expect(backoffMs({ policy, attempt: 3 })).toBe(4_000); // 1000 * 2^2
      expect(backoffMs({ policy, attempt: 4 })).toBe(5_000); // capped
      expect(backoffMs({ policy, attempt: 0 })).toBe(1_000); // exponent floored at 0
    });
  });
});
