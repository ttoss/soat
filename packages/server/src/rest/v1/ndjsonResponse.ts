import { Readable } from 'node:stream';

import type { Context } from 'src/Context';
import { NDJSON_CONTENT_TYPE } from 'src/lib/ndjsonExport';

/**
 * Answers with an NDJSON download: the media type, the filename a browser
 * saves under, and the stream itself.
 *
 * One site so every export answers the same way — the header and the exporter
 * that produces the lines are one change, and `tests/harness/ndjsonExport.test.mjs`
 * fails when a route spells the media type for itself.
 */
export const sendNdjson = (args: {
  ctx: Context;
  filename: string;
  lines: AsyncGenerator<string>;
}): void => {
  args.ctx.set('Content-Type', NDJSON_CONTENT_TYPE);
  args.ctx.set(
    'Content-Disposition',
    `attachment; filename="${args.filename}"`
  );
  args.ctx.status = 200;
  args.ctx.body = Readable.from(args.lines);
};
