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

/**
 * Rewrites an object's own (top-level) keys with `transform`, leaving all
 * values — including nested objects — verbatim.
 *
 * There is deliberately no recursive counterpart. A key-blind transform that
 * descends into a bag rewrites keys the platform does not own, which is the
 * single shape behind every case-transform incident this project has had
 * (#651/#690/#729/#737); `.claude/rules/case-convention.md` bans it outright.
 * Map nested config field by field instead.
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
