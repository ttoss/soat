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
