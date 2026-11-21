/**
 * Field-level rules shared by the datasets and evals halves of the module.
 *
 * They live here rather than in either half so both reach the same definition
 * — the `.claude/rules/modules.md` "shared business rules" shape, applied
 * within a module rather than across layers.
 */
import { DomainError } from '../errors';
import { validateMetadataBag } from './metadataBag';
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
  return validateMetadataBag(metadata);
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

/** A column-sized `varchar`, so a longer key is refused rather than truncated. */
const GROUP_BY_MAX_LENGTH = 255;

/** A key of the items' `metadata`, or null for no grouping. */
export const validateGroupBy = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value === '') {
    return 'group_by must be a non-empty metadata key, or null.';
  }
  if (value.length > GROUP_BY_MAX_LENGTH) {
    return `group_by must be at most ${GROUP_BY_MAX_LENGTH} characters.`;
  }
  return null;
};

const EVIDENCE_KEYS: ReadonlySet<string> = new Set(['required_groups']);

/** Non-empty, unique group names, and a `group_by` to read them from. */
const validateRequiredGroups = (args: {
  groups: unknown;
  groupBy: string | null;
}): string | null => {
  if (!Array.isArray(args.groups)) {
    return 'evidence.required_groups must be an array of group names.';
  }
  const seen = new Set<string>();
  for (const [index, group] of args.groups.entries()) {
    if (typeof group !== 'string' || group === '') {
      return `evidence.required_groups.${index} must be a non-empty string.`;
    }
    if (seen.has(group)) {
      return `evidence.required_groups names '${group}' more than once.`;
    }
    seen.add(group);
  }
  if (args.groups.length > 0 && args.groupBy === null) {
    return 'evidence.required_groups needs group_by to read the groups from.';
  }
  return null;
};

/**
 * The `evidence` object, judged with the `group_by` it will be stored beside:
 * a required group names a value of that key, so requiring one with no key to
 * read it from is refused rather than stored as a rule no run can meet.
 */
export const validateEvidence = (args: {
  evidence: unknown;
  groupBy: string | null;
}): string | null => {
  const { evidence } = args;
  if (evidence === null || evidence === undefined) return null;
  if (!isPlainObject(evidence)) return 'evidence must be an object, or null.';

  const extra = Object.keys(evidence).find((key) => {
    return !EVIDENCE_KEYS.has(key);
  });
  if (extra !== undefined) return `evidence.${extra} is not a known rule.`;

  if (evidence.required_groups === undefined) return null;
  return validateRequiredGroups({
    groups: evidence.required_groups,
    groupBy: args.groupBy,
  });
};

/** Turns a validator's message into the `400` the route surfaces. */
export const assertValid = (message: string | null): void => {
  if (message) throw new DomainError('VALIDATION_FAILED', message);
};
