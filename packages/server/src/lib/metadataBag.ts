import { DomainError } from 'src/errors';

/**
 * Validates a caller-owned `metadata` bag. Shared by every entry point that
 * accepts one (#342) so they enforce the same rule and answer with the same
 * message. Returns an error message, or null when valid.
 *
 * There is no reserved-key list, and that is the point: every piece of state
 * the server owns lives in its own typed column, so nothing a caller writes
 * here can reach platform state. A key spelled `action_id` is just a caller's
 * annotation.
 */
export const validateMetadataBag = (metadata: unknown): string | null => {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return 'metadata must be a JSON object';
  }

  return null;
};

/**
 * Reads a caller-owned `metadata` bag off a request body, rejecting a
 * non-object rather than coercing it. Returns `undefined` when the caller sent
 * no bag at all, which every caller maps to "leave it null".
 *
 * Throws rather than returning a message because every entry point that accepts
 * a bag does the same thing with one, and does it *before* the record is
 * written: a durable object (an orchestration run, an eval run, a task) answers
 * its create call long before it finishes executing, so a rejection the caller
 * could only discover by polling is not a rejection.
 */
export const parseMetadataBag = (
  raw: unknown
): Record<string, unknown> | undefined => {
  if (raw === undefined) return undefined;

  const error = validateMetadataBag(raw);
  if (error) {
    throw new DomainError('VALIDATION_FAILED', error);
  }

  return raw as Record<string, unknown>;
};
