import createDebug from 'debug';

import { DomainError } from '../errors';

const log = createDebug('soat:pagination');

/** A list's page: its size when the caller names none, and its ceiling. */
export type PageBounds = { defaultLimit: number; maxLimit: number };

/** The page every list uses unless it declares its own. */
export const LIST_BOUNDS: PageBounds = { defaultLimit: 50, maxLimit: 100 };

/** Default number of rows returned by a list endpoint when no limit is given. */
export const DEFAULT_LIST_LIMIT = LIST_BOUNDS.defaultLimit;

/** Hard upper bound on a single page, regardless of the requested limit. */
export const MAX_LIST_LIMIT = LIST_BOUNDS.maxLimit;

/** The single, canonical envelope every list endpoint returns. */
export type PaginatedResult<T> = {
  data: T[];
  total: number;
  limit: number;
  offset: number;
};

const refuse = (args: { field: string; value: number; rule: string }) => {
  return new DomainError(
    'VALIDATION_FAILED',
    `${args.field} must be ${args.rule}; got ${args.value}.`,
    { field: args.field }
  );
};

/**
 * The one pagination rule. An absent `limit` is the list's default and an
 * absent `offset` is `0`; a `limit` that is not an integer of at least 1, or an
 * `offset` that is not a non-negative integer, is `VALIDATION_FAILED`. A limit
 * above the ceiling is clamped to it, and the envelope reports the page served.
 */
export const resolvePagination = (args: {
  limit?: number;
  offset?: number;
  bounds?: PageBounds;
}): { limit: number; offset: number } => {
  const bounds = args.bounds ?? LIST_BOUNDS;
  const limit = args.limit ?? bounds.defaultLimit;
  const offset = args.offset ?? 0;

  if (!Number.isInteger(limit) || limit < 1) {
    throw refuse({
      field: 'limit',
      value: limit,
      rule: 'an integer of at least 1',
    });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw refuse({
      field: 'offset',
      value: offset,
      rule: 'a non-negative integer',
    });
  }

  return { limit: Math.min(limit, bounds.maxLimit), offset };
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

/** A list's sort keys, most significant first; never empty. */
export type ListOrder = [ListOrderItem, ...ListOrderItem[]];

/**
 * `order` made total by appending the primary key in the direction of the last
 * key. Rows that tie on the caller's keys otherwise come back in scan order,
 * which two queries need not share, so a page boundary between them repeats
 * one row and drops another.
 */
export const totalListOrder = (order: ListOrder): ListOrderItem[] => {
  const direction = order.reduce<ListOrderItem[1]>((_, item) => {
    return item[1];
  }, order[0][1]);
  return [...order, ['id', direction]];
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
  order: ListOrder;
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

/**
 * The paginated envelope over a set already held in memory — one assembled
 * from several queries, or answered by a vendor API rather than the database.
 * `items` must arrive in a stable order, or two pages can overlap.
 */
export const pageOf = <T>(args: {
  items: T[];
  limit?: number;
  offset?: number;
}): PaginatedResult<T> => {
  const { limit, offset } = resolvePagination(args);
  return {
    data: args.items.slice(offset, offset + limit),
    total: args.items.length,
    limit,
    offset,
  };
};
