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
 * The empty page for a list that can answer without querying — no accessible
 * projects, a filter that resolved to nothing. It still reports the *resolved*
 * `limit`/`offset`, so an early return and a real query describe the page the
 * same way; hardcoding `limit: 50` here would make an early return disagree
 * with {@link paginatedList} about a request it clamped.
 */
export const emptyPage = <T = never>(args: {
  limit?: number;
  offset?: number;
}): PaginatedResult<T> => {
  const { limit, offset } = resolvePagination(args);
  return { data: [], total: 0, limit, offset };
};

/** One sort key of a list: a column of the listed model and its direction. */
export type ListOrderItem = [column: string, direction: 'ASC' | 'DESC'];

/**
 * `order` made total by appending the primary key in the direction of the last
 * key. Rows that tie on the caller's keys otherwise come back in scan order,
 * which two queries need not share, so a page boundary between them repeats
 * one row and drops another.
 */
export const totalListOrder = (order: ListOrderItem[]): ListOrderItem[] => {
  const last = order[order.length - 1];
  if (last?.[0] === 'id') return order;
  return [...order, ['id', last?.[1] ?? 'ASC']];
};

/**
 * The single place the paginated list envelope is produced. `query` performs
 * the `findAndCountAll` with the bounded `limit`/`offset` resolved here and the
 * total `order` built from the caller's (see {@link totalListOrder}), so the
 * fully-typed model call stays at the call site; `map` turns each row into a
 * plain response object. `order` is required: a list that states none is
 * sorted by nothing. `paginatedListOrderContract.test.ts` holds every `query`
 * to the order it is handed.
 *
 * Call sites that `include` associations should pass `distinct: true` so `count`
 * reflects top-level rows rather than the inflated join cardinality.
 */
export const paginatedList = async <M, T>(args: {
  limit?: number;
  offset?: number;
  order: ListOrderItem[];
  query: (pagination: {
    limit: number;
    offset: number;
    order: ListOrderItem[];
  }) => Promise<{ count: number; rows: M[] }>;
  map: (row: M) => T | Promise<T>;
}): Promise<PaginatedResult<T>> => {
  const { limit, offset } = resolvePagination(args);

  log('paginatedList: limit=%d offset=%d', limit, offset);

  const { count, rows } = await args.query({
    limit,
    offset,
    order: totalListOrder(args.order),
  });
  // `Promise.all` handles both sync and async row mappers uniformly.
  const data = await Promise.all(
    rows.map((row) => {
      return args.map(row);
    })
  );

  return { data, total: count, limit, offset };
};
