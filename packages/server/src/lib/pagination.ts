import { createHash } from 'node:crypto';

import { Op } from '@ttoss/postgresdb';
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

/**
 * The one list envelope, as `pagination.yaml#/components/schemas/Page` is the
 * one list response. Only this module builds it (`paginationChokepoints`).
 */
export type Page<T> = { data: T[]; next_cursor: string | null };

/** A list's `where`, as every list function already builds it. */
export type ListWhere = Record<string, unknown>;

/** What a caller sends to page a list. */
export type PageRequest = { limit?: number; cursor?: string };

/**
 * What narrows a list: every caller-supplied filter and the parent a list is
 * nested under. Hashed into the cursor, so a cursor answers only the list it
 * was minted for.
 */
export type ListFilters = Record<string, unknown>;

/**
 * The bounded `limit`. An absent one is the list's default; one that is not an
 * integer of at least 1 is `VALIDATION_FAILED`; one above the ceiling is
 * clamped to it.
 */
export const resolveLimit = (args: {
  limit?: number;
  bounds?: PageBounds;
}): number => {
  const bounds = args.bounds ?? LIST_BOUNDS;
  const limit = args.limit ?? bounds.defaultLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `limit must be an integer of at least 1; got ${limit}.`,
      { field: 'limit' }
    );
  }
  return Math.min(limit, bounds.maxLimit);
};

/** A plain-data rendering of `value` whose output does not depend on key order. */
const canonical = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value)
      .sort()
      .flatMap((key) => {
        const member: unknown = Reflect.get(value, key);
        return member === undefined ? [] : [[key, canonical(member)]];
      });
  }
  return value;
};

const fingerprint = (filters: ListFilters): string => {
  return createHash('sha256')
    .update(JSON.stringify(canonical(filters)))
    .digest('base64url')
    .slice(0, 16);
};

/** A sort-key value as a cursor carries it. */
type CursorValue = string | number | boolean | { d: string };

type CursorPayload = { k: CursorValue[]; f: string } | { o: number; f: string };

const invalidCursor = (reason: string): DomainError => {
  return new DomainError('INVALID_CURSOR', `The cursor ${reason}.`, {
    field: 'cursor',
  });
};

const encodeCursor = (payload: CursorPayload): string => {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
};

const isCursorValue = (value: unknown): value is CursorValue => {
  if (['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const iso: unknown = Reflect.get(value, 'd');
  return (
    Object.keys(value).length === 1 &&
    typeof iso === 'string' &&
    !Number.isNaN(Date.parse(iso))
  );
};

const parseCursor = (cursor: string): unknown => {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor('is malformed');
  }
};

/**
 * The position `cursor` carries under `key`, checked against the list it is
 * used on: a cursor that does not decode, or was minted under other filters,
 * is `INVALID_CURSOR`.
 */
const decodeCursor = (args: {
  cursor: string;
  key: 'k' | 'o';
  filters: ListFilters;
}): unknown => {
  const payload = parseCursor(args.cursor);
  if (typeof payload !== 'object' || payload === null) {
    throw invalidCursor('is malformed');
  }
  if (Reflect.get(payload, 'f') !== fingerprint(args.filters)) {
    throw invalidCursor(
      'was issued for other filters; send the same filters, or drop the cursor to start over'
    );
  }
  return Reflect.get(payload, args.key);
};

const decodeKeyset = (args: {
  cursor: string;
  filters: ListFilters;
  length: number;
}): CursorValue[] => {
  const values = decodeCursor({ ...args, key: 'k' });
  if (
    !Array.isArray(values) ||
    values.length !== args.length ||
    !values.every(isCursorValue)
  ) {
    throw invalidCursor('is malformed');
  }
  return values;
};

const decodeOffset = (args: {
  cursor: string;
  filters: ListFilters;
}): number => {
  const offset = decodeCursor({ ...args, key: 'o' });
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw invalidCursor('is malformed');
  }
  return offset;
};

const toCursorValue = (value: unknown): CursorValue => {
  if (value instanceof Date) return { d: value.toISOString() };
  if (isCursorValue(value)) return value;
  return String(value);
};

const fromCursorValue = (value: CursorValue): unknown => {
  return typeof value === 'object' ? new Date(value.d) : value;
};

/** One sort key of a list: a column of the listed model and its direction. */
export type ListOrderItem = [column: string, direction: 'ASC' | 'DESC'];

/** A list's sort keys, most significant first; never empty. */
export type ListOrder = [ListOrderItem, ...ListOrderItem[]];

/**
 * `order` made total by appending `tiebreak` in the direction of the last key.
 * Rows that tie on the caller's keys otherwise come back in scan order, which
 * two queries need not share, so a page boundary between them repeats one row
 * and drops another. The tiebreak is a public column, never the internal `id`,
 * because the cursor carries its value.
 */
export const totalListOrder = (args: {
  order: ListOrder;
  tiebreak?: string[];
}): ListOrderItem[] => {
  const direction = args.order[args.order.length - 1][1];
  return [
    ...args.order,
    ...(args.tiebreak ?? ['publicId']).map((column): ListOrderItem => {
      return [column, direction];
    }),
  ];
};

/**
 * The rows strictly after `values` in `order`. Sort keys are `NOT NULL`
 * columns, so the comparison needs no null placement.
 */
const afterPosition = (args: {
  order: ListOrderItem[];
  values: unknown[];
}): ListWhere => {
  const [[column, direction], ...restOrder] = args.order;
  const [value, ...restValues] = args.values;
  const beyond = { [column]: { [direction === 'ASC' ? Op.gt : Op.lt]: value } };
  if (restOrder.length === 0) return beyond;
  return {
    [Op.or]: [
      beyond,
      {
        [Op.and]: [
          { [column]: value },
          afterPosition({ order: restOrder, values: restValues }),
        ],
      },
    ],
  };
};

const andWhere = (
  base: ListWhere | undefined,
  extra: ListWhere | null
): ListWhere | undefined => {
  if (!extra) return base;
  return base ? { [Op.and]: [base, extra] } : extra;
};

/**
 * The empty page for a list that can answer without querying — no accessible
 * projects, a filter that resolved to nothing. It still validates the request,
 * so an early return and a real query refuse the same bad `limit`.
 */
export const emptyPage = <T = never>(args: PageRequest): Page<T> => {
  resolveLimit(args);
  if (args.cursor !== undefined) parseCursor(args.cursor);
  return { data: [], next_cursor: null };
};

/**
 * The single place a database list is paged. Keyset, never offset: the cursor
 * carries the last row's sort-key values, so a row inserted or removed between
 * two calls neither repeats nor skips one.
 *
 * `query` performs a `findAll` with the `where` (the caller's `where` ANDed
 * with the position after the cursor), `limit` and total `order` built here;
 * it must not add a `where` of its own at the top level. `map` turns each row
 * into a plain response object. `filters` is what the caller narrowed the list
 * by (see {@link ListFilters}). `paginatedListOrderContract.test.ts` holds
 * every `query` to the `where` and `order` it is handed.
 */
export const paginatedList = async <M extends object, T>(args: {
  limit?: number;
  cursor?: string;
  bounds?: PageBounds;
  filters: ListFilters;
  where: ListWhere | undefined;
  order: ListOrder;
  /** Columns that make `order` total; `publicId` unless the model has none. */
  tiebreak?: string[];
  query: (page: {
    where: ListWhere | undefined;
    limit: number;
    order: ListOrderItem[];
  }) => Promise<M[]>;
  map: (row: M) => T | Promise<T>;
}): Promise<Page<T>> => {
  const limit = resolveLimit(args);
  const order = totalListOrder(args);
  const values = args.cursor
    ? decodeKeyset({
        cursor: args.cursor,
        filters: args.filters,
        length: order.length,
      })
    : null;

  log('paginatedList: limit=%d cursor=%s', limit, args.cursor ? 'yes' : 'no');

  const rows = await args.query({
    where: andWhere(
      args.where,
      values
        ? afterPosition({ order, values: values.map(fromCursorValue) })
        : null
    ),
    limit: limit + 1,
    order,
  });
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const data = await Promise.all(
    pageRows.map((row) => {
      return args.map(row);
    })
  );

  return {
    data,
    next_cursor:
      rows.length > limit && last
        ? encodeCursor({
            k: order.map(([column]) => {
              return toCursorValue(Reflect.get(last, column));
            }),
            f: fingerprint(args.filters),
          })
        : null,
  };
};

/**
 * The page over a set that is not a keyset scan — held in memory, answered by
 * a vendor API, or ordered by a computed value. The cursor carries an offset.
 * `items` must arrive in a stable order, or two pages can overlap.
 */
export const pageOf = <T>(args: {
  items: T[];
  limit?: number;
  cursor?: string;
  bounds?: PageBounds;
  filters: ListFilters;
}): Page<T> => {
  const limit = resolveLimit(args);
  const offset = args.cursor
    ? decodeOffset({ cursor: args.cursor, filters: args.filters })
    : 0;
  const end = offset + limit;
  return {
    data: args.items.slice(offset, end),
    next_cursor:
      end < args.items.length
        ? encodeCursor({ o: end, f: fingerprint(args.filters) })
        : null,
  };
};

/**
 * The offset a {@link pageOf}-style cursor names, for a list whose query
 * pages by `OFFSET` itself (an aggregate ordered by a computed value). Read
 * `limit + 1` rows and hand them to {@link offsetPage}.
 */
export const resolveOffsetPage = (args: {
  limit?: number;
  cursor?: string;
  bounds?: PageBounds;
  filters: ListFilters;
}): { limit: number; offset: number } => {
  return {
    limit: resolveLimit(args),
    offset: args.cursor
      ? decodeOffset({ cursor: args.cursor, filters: args.filters })
      : 0,
  };
};

/** The page over rows read at {@link resolveOffsetPage}'s offset, `limit + 1` of them. */
export const offsetPage = <T>(args: {
  rows: T[];
  limit: number;
  offset: number;
  filters: ListFilters;
}): Page<T> => {
  return {
    data: args.rows.slice(0, args.limit),
    next_cursor:
      args.rows.length > args.limit
        ? encodeCursor({
            o: args.offset + args.limit,
            f: fingerprint(args.filters),
          })
        : null,
  };
};
