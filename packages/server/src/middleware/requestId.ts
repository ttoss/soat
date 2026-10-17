import { randomUUID } from 'node:crypto';

import type { Context } from '../Context';
import { runWithRequestId } from '../lib/requestCorrelation';

type Next = () => Promise<void>;

// The id is forwarded to the servers `mcp` tools call and written to logs and
// the audit log, so a caller's value is honored only as a short token.
const HONORED_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Generates a per-request correlation id, exposes it as `ctx.state.requestId`,
 * and echoes it in an `X-Request-Id` response header. The header is set before
 * `next()` so it is present on every response — including error responses set
 * later by the error middleware. A caller-supplied `X-Request-Id` is honored so
 * a correlation id can be threaded across services; otherwise a fresh UUID is
 * minted.
 *
 * The audit log records this id on each entry, tying a stored entry back to the
 * exact request that produced it, and every `mcp` tool request the work sends
 * carries it (`requestCorrelation.ts`).
 */
export const requestIdMiddleware = async (ctx: Context, next: Next) => {
  const incoming = ctx.headers?.['x-request-id'];
  const requestId =
    typeof incoming === 'string' && HONORED_REQUEST_ID.test(incoming)
      ? incoming
      : randomUUID();

  ctx.state = ctx.state ?? {};
  ctx.state.requestId = requestId;
  ctx.set('X-Request-Id', requestId);

  await runWithRequestId({ requestId, fn: next });
};
