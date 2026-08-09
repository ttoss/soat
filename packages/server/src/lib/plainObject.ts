/**
 * `true` when `value` is a plain, keyed object — a JSON-shaped bag, not an
 * array, `Date`, or class instance. The right guard for JSON-shaped data
 * (request bodies, jsonb columns, formation property bags) before treating a
 * value as a keyed record.
 *
 * This is the single definition. Thirteen copies of it existed across
 * `src/lib` with three different narrowings, which is the drift this module
 * exists to prevent.
 */
export const isPlainObject = (
  value: unknown
): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
