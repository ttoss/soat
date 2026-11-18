import { Op } from '@ttoss/postgresdb';

/**
 * How a caller asks for the rows whose filtered column is null.
 *
 * Not the literal `null` the field holds: the CLI's flag parser reads the token
 * `null` as JSON null for every nullable field it has, so a filter spelled that
 * way would reach the server as an empty value from one of its own clients.
 * A word no layer sniffs keeps one spelling working everywhere.
 */
export const FILTER_NONE = 'none';

/**
 * The predicate for a set of requested values, ORed, `null` among them.
 *
 * `IN (…, NULL)` never matches a NULL row, so that half is its own predicate
 * rather than another element of the list.
 */
export const nullableInWhere = <T extends string>(
  values: readonly (T | null)[]
): unknown => {
  const named = values.filter((value) => {
    return value !== null;
  });
  if (named.length === values.length) return named;
  return {
    [Op.or]: [
      ...(named.length > 0 ? [{ [Op.in]: named }] : []),
      { [Op.is]: null },
    ],
  };
};
