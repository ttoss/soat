/**
 * Field-level rules shared by the datasets and evals halves of the module.
 *
 * They live here rather than in either half so both reach the same definition
 * — the `.claude/rules/modules.md` "shared business rules" shape, applied
 * within a module rather than across layers.
 */
import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

export const requireName = (name: unknown): string => {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'name is required and must be a non-empty string.'
    );
  }
  return name;
};

/** `undefined` leaves the field untouched; `null` clears it. */
export const requireOptionalText = (
  value: unknown,
  field: string
): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${field} must be a string or null.`
    );
  }
  return value;
};

/**
 * A dataset item's `input` is replayed verbatim as the generation's messages,
 * so it has to be message-shaped before it is stored — a run is the wrong place
 * to discover that a fixture was authored as a bare string.
 */
export const validateDatasetItemInput = (input: unknown): string | null => {
  if (!Array.isArray(input) || input.length === 0) {
    return 'input must be a non-empty array of { role, content } messages.';
  }
  for (const [index, message] of input.entries()) {
    if (!isPlainObject(message)) {
      return `input.${index} must be an object with role and content.`;
    }
    if (typeof message.role !== 'string' || message.role === '') {
      return `input.${index}.role is required and must be a non-empty string.`;
    }
    if (message.content === undefined || message.content === null) {
      return `input.${index}.content is required.`;
    }
  }
  return null;
};

/** Free-form tag bag: an object or null, never inspected further. */
export const validateItemMetadata = (metadata: unknown): string | null => {
  if (metadata === null || metadata === undefined) return null;
  return isPlainObject(metadata) ? null : 'metadata must be an object or null.';
};

/** 0–1 inclusive, or null to leave the eval ungated. */
export const validatePassThreshold = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'pass_threshold must be a number between 0 and 1, or null.';
  }
  if (value < 0 || value > 1) {
    return 'pass_threshold must be between 0 and 1.';
  }
  return null;
};

/** Turns a validator's message into the `400` the route surfaces. */
export const assertValid = (message: string | null): void => {
  if (message) throw new DomainError('VALIDATION_FAILED', message);
};
