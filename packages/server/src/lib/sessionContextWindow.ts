import { DomainError } from '../errors';

/**
 * A session's `max_context_messages` is a positive integer, `null` to defer to
 * the agent's window, or absent to leave it unchanged. The spec types it; the
 * floor is enforced here, since request validation does not read `minimum`.
 */
export const readMaxContextMessages = (
  value: number | null | undefined
): number | null | undefined => {
  if (typeof value === 'number' && value < 1) {
    throw new DomainError(
      'VALIDATION_FAILED',
      '`max_context_messages` must be a positive integer or null.',
      { max_context_messages: value }
    );
  }
  return value;
};
