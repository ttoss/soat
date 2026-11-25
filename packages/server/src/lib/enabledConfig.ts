/**
 * An agent setting stored as `{ enabled }` (`prompt_caching`,
 * `citation_config`). One reading and one write check for all of them.
 */
import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

export type EnabledConfig = { enabled: boolean };

/**
 * Absent, malformed or `enabled` anything but `true` reads as off: the column
 * is untyped JSON, and a feature an agent did not ask for must never switch on.
 */
export const readEnabledConfig = (value: unknown): EnabledConfig => {
  if (!isPlainObject(value)) return { enabled: false };
  return { enabled: value.enabled === true };
};

/**
 * Unknown keys are refused rather than ignored so a typo surfaces as a `400`
 * instead of an agent its author believes has the feature on.
 */
export const assertValidEnabledConfig = (args: {
  field: string;
  value: unknown;
}): void => {
  const { field, value } = args;
  if (value === null || value === undefined) return;

  if (!isPlainObject(value)) {
    throw new DomainError('VALIDATION_FAILED', `'${field}' must be an object.`);
  }

  const unknown = Object.keys(value).filter((key) => {
    return key !== 'enabled';
  });
  if (unknown.length > 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `'${field}' has no such field(s): ${unknown.join(', ')}.`
    );
  }

  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new DomainError(
      'VALIDATION_FAILED',
      `'${field}.enabled' must be a boolean.`
    );
  }
};
