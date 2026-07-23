import createDebug from 'debug';

const log = createDebug('soat:pagination');

/** Default number of rows returned by a list endpoint when no limit is given. */
export const DEFAULT_LIST_LIMIT = 50;

/** Hard upper bound on a single page, regardless of the requested limit. */
export const MAX_LIST_LIMIT = 100;

/** The single, canonical envelope every list endpoint returns. */
export type PaginatedResult<T> = {
  data: T[];
  total: number;
  limit: number;
  offset: number;
};

/**
 * Normalizes raw `limit`/`offset` inputs to safe, bounded integers. A missing
 * limit falls back to {@link DEFAULT_LIST_LIMIT}; any limit is clamped to
 * `[1, MAX_LIST_LIMIT]`. A missing or negative offset becomes `0`.
 */
export const resolvePagination = (args: {
  limit?: number;
  offset?: number;
}): { limit: number; offset: number } => {
  const rawLimit = args.limit ?? DEFAULT_LIST_LIMIT;
  const rawOffset = args.offset ?? 0;

  const limit = Math.min(
    Math.max(
      1,
      Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIST_LIMIT
    ),
    MAX_LIST_LIMIT
  );
  const offset = Math.max(
    0,
    Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0
  );

  return { limit, offset };
};

/**
 * The single place the paginated list envelope is produced. `query` performs
 * the `findAndCountAll` (or equivalent) call with the bounded `limit`/`offset`
 * this helper resolves, so the concrete, fully-typed model call stays at the
 * call site; `map` turns each row into a plain response object.
 *
 * Call sites that `include` associations should pass `distinct: true` to the
 * underlying `findAndCountAll` so `count` reflects top-level rows rather than
 * the inflated join cardinality.
 *
 * @example
 * return paginatedList({
 *   limit: args.limit,
 *   offset: args.offset,
 *   query: ({ limit, offset }) =>
 *     db.Agent.findAndCountAll({ where, include, distinct: true, limit, offset }),
 *   map: mapAgent,
 * });
 */
export const paginatedList = async <M, T>(args: {
  limit?: number;
  offset?: number;
  query: (pagination: {
    limit: number;
    offset: number;
  }) => Promise<{ count: number; rows: M[] }>;
  map: (row: M) => T | Promise<T>;
}): Promise<PaginatedResult<T>> => {
  const { limit, offset } = resolvePagination(args);

  log('paginatedList: limit=%d offset=%d', limit, offset);

  const { count, rows } = await args.query({ limit, offset });
  // `Promise.all` handles both sync and async row mappers uniformly.
  const data = await Promise.all(
    rows.map((row) => {
      return args.map(row);
    })
  );

  return { data, total: count, limit, offset };
};
