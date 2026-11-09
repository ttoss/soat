import { DomainError } from '../errors';
import { compileJsonSchema, describeSchemaErrors } from './jsonSchemaValidator';
import { isPlainObject } from './plainObject';
import { jsonBytes } from './quotaStorage';

/** The largest `data` one item holds, measured as its JSON serialization. */
export const COLLECTION_ITEM_MAX_BYTES = 64 * 1024;

/**
 * A key travels in a URL path and as the last segment of an item's SRN, so it
 * excludes `/` and the glob characters `*` and `?` a policy pattern reads.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

export const readItemKey = (value: string): string => {
  if (!KEY_PATTERN.test(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `'${value}' is not an item key: 1–256 characters of letters, digits and . _ : @ -, starting with a letter or digit.`,
      { field: 'key' }
    );
  }
  return value;
};

/**
 * JSON Merge Patch (RFC 7386): an object merges key by key, `null` removes
 * the key, anything else replaces it.
 */
export const mergePatch = (args: {
  target: unknown;
  patch: unknown;
}): unknown => {
  if (!isPlainObject(args.patch)) return args.patch;
  const merged: Record<string, unknown> = isPlainObject(args.target)
    ? { ...args.target }
    : {};
  for (const [key, value] of Object.entries(args.patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = mergePatch({ target: merged[key], patch: value });
    }
  }
  return merged;
};

/**
 * The `data` an item will hold, refused when it is not an object, is over
 * {@link COLLECTION_ITEM_MAX_BYTES} or breaks the collection's schema.
 */
export const assertItemData = (args: {
  data: unknown;
  schema: Record<string, unknown> | null;
}): Record<string, unknown> => {
  if (!isPlainObject(args.data)) {
    throw new DomainError('VALIDATION_FAILED', 'data must be a JSON object.', {
      field: 'data',
    });
  }

  const bytes = jsonBytes(args.data);
  if (bytes > COLLECTION_ITEM_MAX_BYTES) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `data is ${bytes} bytes; an item holds at most ${COLLECTION_ITEM_MAX_BYTES}.`,
      { field: 'data', bytes, max_bytes: COLLECTION_ITEM_MAX_BYTES }
    );
  }

  if (args.schema) {
    // A stored schema always compiles: one that does not is refused when the
    // collection is written.
    const validate = compileJsonSchema(args.schema);
    if (validate && !validate(args.data)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `data does not satisfy the collection's schema: ${describeSchemaErrors(validate.errors)}`,
        { field: 'data' }
      );
    }
  }

  return args.data;
};
