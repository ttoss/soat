import type { MemorySource } from '@soat/postgresdb';
import { MEMORY_SOURCES } from '@soat/postgresdb';
import { DomainError } from 'src/errors';
import { isStringRecord } from 'src/lib/tags';

/**
 * Request-body parsing for the memories routes.
 *
 * Every field is narrowed here rather than trusted from the body: a threshold
 * reaches the write algorithm, a `supersedes` id reaches a `where` clause, and
 * JSON can put an object where either belongs.
 */

const normalizeSourceType = (value: unknown): MemorySource | undefined => {
  return MEMORY_SOURCES.includes(value as MemorySource)
    ? (value as MemorySource)
    : undefined;
};

/**
 * A per-request threshold, bounded to `[0, 1]` — the range a cosine similarity
 * can take. A value outside it silently disables one of the three outcomes for
 * that write, so it is refused rather than clamped.
 */
export const readThreshold = (args: {
  value: unknown;
  field: string;
}): number | undefined => {
  if (args.value === undefined) return undefined;
  if (
    typeof args.value !== 'number' ||
    !Number.isFinite(args.value) ||
    args.value < 0 ||
    args.value > 1
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${args.field} must be a number between 0 and 1`
    );
  }
  return args.value;
};

/**
 * The provenance pair as one read. It is the whole contract: `conversation`
 * means `source_id` names the conversation, `manual` means there is nothing to
 * name. Accepting either half alone would store a provenance that says one
 * thing and points at another.
 */
export const readSourcePair = (body: {
  source_type?: string;
  source_id?: string;
}): MemorySource => {
  const sourceType = normalizeSourceType(body.source_type) ?? 'manual';
  if (sourceType === 'conversation' && !body.source_id) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "source_id is required when source_type is 'conversation'"
    );
  }
  if (sourceType !== 'conversation' && body.source_id) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "source_id is only accepted when source_type is 'conversation'"
    );
  }
  return sourceType;
};

/**
 * The declared supersede target, as a memory id. Narrowed here rather than
 * trusted from the body: the value reaches a `where` clause on `public_id`, and
 * JSON can put an object where a string belongs.
 */
export const readSupersedes = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'supersedes must be a memory id'
    );
  }
  return value;
};

/**
 * Validates an optional `tags` bag on a request body. `allowNull` permits an
 * explicit null, which the update route uses to clear the field. Returns an
 * error message, or null when the field is valid or absent.
 *
 * The `metadata` bag beside it is read by `lib/metadataBag.ts` instead, which
 * both refuses a non-object and narrows it — one reader for the bag, wherever
 * it is accepted.
 */
export const validateTagsBag = (
  body: { tags?: unknown },
  opts: { allowNull: boolean }
): string | null => {
  if (body.tags === undefined) return null;
  if (opts.allowNull && body.tags === null) return null;
  if (!isStringRecord(body.tags)) {
    return 'tags must be an object of string values';
  }
  return null;
};
