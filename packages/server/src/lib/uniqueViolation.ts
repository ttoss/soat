import { DomainError } from '../errors';

/**
 * `true` when `error` is a Sequelize unique-constraint violation.
 *
 * Matched by `name` so no Sequelize error class needs importing here — the
 * class is not exported from `@ttoss/postgresdb`, which is why six modules had
 * each hand-rolled this check with a different narrowing.
 */
export const isUniqueViolation = (error: unknown): boolean => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'SequelizeUniqueConstraintError'
  );
};

/**
 * Rethrows a unique-constraint violation as a `NAME_CONFLICT` `DomainError`
 * carrying `message`, and rethrows anything else untouched.
 *
 * Use it as the whole body of a `catch`, so a write that races a duplicate
 * answers `409` instead of `500`. Prefix the call with `throw` — it always
 * throws, and the keyword is what tells control-flow analysis the `catch`
 * never completes, so a `let` assigned in the `try` stays narrowed after it:
 *
 * ```ts
 * let file;
 * try {
 *   file = await db.File.create({ … });
 * } catch (error) {
 *   throw rethrowAsConflict(error, 'A file already exists at that path.');
 * }
 * ```
 */
export const rethrowAsConflict = (error: unknown, message: string): never => {
  if (isUniqueViolation(error)) {
    throw new DomainError('NAME_CONFLICT', message);
  }
  throw error;
};
