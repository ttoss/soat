import { DomainError } from 'src/errors';
import { isObjectRecord } from 'src/lib/openapiSchemaFields';

/**
 * Validates a caller-owned `metadata` bag. Shared by every entry point that
 * accepts one so they enforce the same rule and answer with the same
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

/** `parseMetadataBag` for update bodies where `null` means "clear the bag". */
export const readNullableMetadataBag = (
  raw: unknown
): Record<string, unknown> | null | undefined => {
  if (raw === null) return null;
  return parseMetadataBag(raw);
};

/**
 * The same bag off a surface whose wire has only text: a multipart field
 * carries the object serialized, so it is parsed here and then judged by the
 * one rule above. A JSON body on the same route sends the object itself and
 * reaches that rule directly.
 *
 * Text that is not JSON at all is refused rather than stored as a string: the
 * caller wrote an object and a stored string is not one, which is the two
 * contracts for one field this exists to keep from coming back.
 */
export const parseMetadataBagField = (
  raw: unknown
): Record<string, unknown> | undefined => {
  if (typeof raw !== 'string') return parseMetadataBag(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError(
      'VALIDATION_FAILED',
      'metadata must be a JSON object, sent as JSON text in a multipart field'
    );
  }
  return parseMetadataBag(parsed);
};

/**
 * The bag as a formation template carries it: `null` clears it, an object
 * replaces it, and anything else leaves the stored bag alone rather than
 * throwing — a template's field types are refused by the spec loader before a
 * property reaches a module, so a non-object here is not a caller error to
 * report a second time.
 */
export const toNullableMetadataBag = (
  value: unknown
): Record<string, unknown> | null | undefined => {
  if (value === null) return null;
  return isObjectRecord(value) ? value : undefined;
};
