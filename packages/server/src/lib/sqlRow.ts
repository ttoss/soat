import { DomainError } from '../errors';

/**
 * Narrowing readers for raw `sequelize.query` result rows.
 *
 * A raw query returns `unknown[]`, and the alternative to reading it one column
 * at a time is a blanket cast that turns a changed column name into a silent
 * `NaN` or `undefined` several layers downstream. These throw at the row
 * instead, naming the column, so a query and its reader cannot drift apart
 * unnoticed.
 *
 * Postgres types that matter here: a `COUNT` arrives as a string (it is
 * `bigint`) or a number depending on the driver's parser, and a `SUM` over a
 * `DECIMAL` arrives as a string so no precision is lost on the way out.
 */

const columnError = (column: string, expected: string): DomainError => {
  return new DomainError(
    'INTERNAL_ERROR',
    `SQL row column '${column}' is not ${expected}.`
  );
};

/** One result row as a plain record, or a throw if the driver returned a scalar. */
export const asSqlRow = (row: unknown): Record<string, unknown> => {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new DomainError(
      'INTERNAL_ERROR',
      'SQL query returned a non-object row.'
    );
  }
  return { ...row };
};

/** A `COUNT`, whether the driver parsed the `bigint` or left it a string. */
export const readSqlCount = (
  row: Record<string, unknown>,
  column: string
): number => {
  const value = row[column];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw columnError(column, 'a count');
};

/**
 * A `DECIMAL` (typically a `SUM`), as the string Postgres returned. Null when
 * the column is null — which for a `SUM` means nothing was summed, not zero.
 */
export const readSqlDecimal = (
  row: Record<string, unknown>,
  column: string
): string | null => {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw columnError(column, 'a decimal');
};

/** A text column that may be null. */
export const readSqlNullableText = (
  row: Record<string, unknown>,
  column: string
): string | null => {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw columnError(column, 'text');
};

/** A text column that must be present. */
export const readSqlText = (
  row: Record<string, unknown>,
  column: string
): string => {
  const value = readSqlNullableText(row, column);
  if (value === null) {
    throw new DomainError(
      'INTERNAL_ERROR',
      `SQL row column '${column}' is unexpectedly null.`
    );
  }
  return value;
};
