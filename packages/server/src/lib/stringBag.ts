import { DomainError } from '../errors';

/**
 * Whether a value is a flat bag of string values. Rejects arrays so a
 * `["a","b"]` body fails loudly rather than being read as an object with
 * numeric keys.
 */
export const isStringRecord = (
  value: unknown
): value is Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((item) => {
    return typeof item === 'string';
  });
};

/**
 * Reads a bag whose values are strings — a tag bag, a `tool_context`. Anything
 * else is a client error, never coerced: `String(["a","b"])` is `"a,b"`, so a
 * coerced value is one nobody wrote, and it is what a policy condition matches
 * or an outbound header carries.
 */
export const readStringBag = (args: {
  field: string;
  value: unknown;
}): Record<string, string> => {
  if (!isStringRecord(args.value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${args.field} must be an object of string values`
    );
  }
  return args.value;
};
