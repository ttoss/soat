/**
 * Generic type-coercion helpers shared by REST handlers and formation modules.
 * All functions accept `unknown` and return typed values or `undefined`/`null`
 * to signal that the input was absent or the wrong type.
 */

export const toOptionalString = (value: unknown): string | undefined => {
  return typeof value === 'string' ? value : undefined;
};

export const toNullableString = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
};

export const toNullableNumber = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return typeof value === 'number' ? value : undefined;
};

export const toNullableArray = <T>(value: unknown): T[] | null | undefined => {
  if (value === null) return null;
  return Array.isArray(value) ? (value as T[]) : undefined;
};

export const toNullableObject = (value: unknown): object | null | undefined => {
  if (value === null) return null;
  return typeof value === 'object' && !Array.isArray(value)
    ? (value as object)
    : undefined;
};

export const toNullableStringOrObject = (
  value: unknown
): string | object | null | undefined => {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return typeof value === 'object' && !Array.isArray(value)
    ? (value as object)
    : undefined;
};

/**
 * Accepts either camelCase or snake_case key, returning the first defined value.
 * Used to normalise fields that arrive as camelCase from the REST middleware but
 * as snake_case in formation module property bags.
 */
export const coalesce = <T>(
  camelValue: unknown,
  snakeValue: unknown,
  mapper: (v: unknown) => T
): T => {
  return mapper(camelValue !== undefined ? camelValue : snakeValue);
};

export const camelToSnakeKey = (key: string): string => {
  return key.replace(/[A-Z]/g, (char) => {
    return `_${char.toLowerCase()}`;
  });
};

export const snakeToCamelKey = (key: string): string => {
  return key.replace(/_([a-z])/g, (_, char: string) => {
    return (char as string).toUpperCase();
  });
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Recursively rewrites every object key with `transform`, descending into
 * nested plain objects and arrays while leaving all leaf *values* untouched.
 *
 * Use this to convert a whole nested config bag between the external snake_case
 * contract and internal camelCase in one call — instead of enumerating fields
 * by hand, which silently drops any field a future change forgets to list. Only
 * safe for bags whose keys are all part of the resource contract; do **not**
 * use it on free-form value maps that must round-trip verbatim (JSON Schema,
 * user-defined metadata, JSON-Logic), which is why `caseTransform` keeps its
 * own skip-key list rather than sharing this helper wholesale.
 */
export const convertKeysDeep = (
  value: unknown,
  transform: (key: string) => string
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return convertKeysDeep(item, transform);
    });
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => {
        return [transform(key), convertKeysDeep(val, transform)];
      })
    );
  }
  return value;
};

/**
 * Rewrites only an object's own (top-level) keys with `transform`, leaving all
 * values — including nested objects — verbatim. The shallow counterpart to
 * {@link convertKeysDeep}, for bags whose nested values must round-trip
 * untouched.
 */
export const convertKeys = (
  obj: Record<string, unknown>,
  transform: (key: string) => string
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => {
      return [transform(key), value];
    })
  );
};

/**
 * Rewrites a formation template's **top-level** property keys from camelCase
 * to snake_case so a template authored in either casing validates against the
 * snake_case OpenAPI schema. Shallow by design: nested value bags (a policy
 * `document`, a webhook config, arbitrary `metadata`, orchestration node/edge
 * expressions) are left verbatim and normalized separately by the module that
 * owns them, when it owns them. Shared by every formation module.
 */
export const normalizePropertyKeys = (
  properties: Record<string, unknown>
): Record<string, unknown> => {
  return convertKeys(properties, camelToSnakeKey);
};
