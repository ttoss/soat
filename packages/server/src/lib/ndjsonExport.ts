import { Op } from '@ttoss/postgresdb';

/**
 * The one exporter every NDJSON endpoint streams through: one JSON object per
 * line, oldest first, paged so the whole table is never held in memory.
 *
 * Ascending `(created_at, id)` is what makes an export readable while the
 * table is still being written: a row that arrives mid-export is appended
 * after the cursor rather than shifting rows the consumer already read, which
 * a `DESC` order would do to every page boundary.
 *
 * The cursor names the last row emitted rather than counting rows skipped. An
 * export is a long read against a table under write, and `OFFSET` walks a list
 * that moves underneath it: a row inserted before the cursor pushes one row
 * across the page boundary, and that row is never emitted. A keyset resumes
 * from a position that exists, so the only rows a concurrent write can affect
 * are ones the consumer has not reached.
 */

/** The last row emitted, as the position the next batch resumes after. */
export type ExportCursor = { createdAt: Date; id: number };

/**
 * Rows fetched per round trip. Bounds the exporter's memory to one batch
 * regardless of how many rows the project has.
 */
export const EXPORT_BATCH_SIZE = 500;

/**
 * The media type of every NDJSON response. Declared here so the exporter and
 * the header naming it are one change; `tests/harness/ndjsonExport.test.mjs`
 * fails when a second site spells it.
 */
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';

/** The order every export reads in, and the cursor is taken from. */
export const EXPORT_ORDER: [string, 'ASC'][] = [
  ['createdAt', 'ASC'],
  ['id', 'ASC'],
];

/**
 * The `where` fragment that resumes after a cursor, in `(created_at, id)`
 * order. `undefined` for the first batch, which starts at the beginning.
 *
 * Two arms rather than one: rows sharing a timestamp are ordered by `id`, so
 * resuming on `created_at` alone would re-emit every row written in the same
 * millisecond as the cursor, and resuming on `id` alone would skip rows whose
 * ids were assigned out of timestamp order.
 */
export const afterCursorWhere = (
  after: ExportCursor | undefined
): Record<symbol, unknown> | undefined => {
  if (!after) return undefined;
  return {
    [Op.or]: [
      { createdAt: { [Op.gt]: after.createdAt } },
      { createdAt: after.createdAt, id: { [Op.gt]: after.id } },
    ],
  };
};

/**
 * Streams the rows `findBatch` returns as NDJSON lines.
 *
 * `findBatch` owns the query — its model, filters and includes — and is handed
 * the cursor and the batch size; `map` turns a row into the wire shape the
 * endpoint's read contract already returns, so an export and a listing never
 * describe the same row differently.
 */
export async function* streamNdjson<
  Row extends { id?: number; createdAt?: Date },
>(args: {
  findBatch: (batch: {
    after: ExportCursor | undefined;
    limit: number;
  }) => Promise<Row[]>;
  map: (row: Row) => unknown;
}): AsyncGenerator<string> {
  let after: ExportCursor | undefined;

  for (;;) {
    const rows = await args.findBatch({ after, limit: EXPORT_BATCH_SIZE });
    if (rows.length === 0) return;

    for (const row of rows) {
      yield `${JSON.stringify(args.map(row))}\n`;
    }

    if (rows.length < EXPORT_BATCH_SIZE) return;

    // A persisted row always carries both; the model types them optional
    // because the same type describes a row being created.
    const last = rows[rows.length - 1];
    after = { createdAt: last.createdAt!, id: last.id! };
  }
}
