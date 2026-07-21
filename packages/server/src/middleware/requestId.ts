import { randomUUID } from 'node:crypto';

import type { Context } from '../Context';

type Next = () => Promise<void>;

/**
 * Generates a per-request correlation id, exposes it as `ctx.state.requestId`,
 * and echoes it in an `X-Request-Id` response header. The header is set before
 * `next()` so it is present on every response — including error responses set
 * later by the error middleware. A caller-supplied `X-Request-Id` is honored so
 * a correlation id can be threaded across services; otherwise a fresh UUID is
 * minted.
 *
 * The audit log records this id on each entry, tying a stored entry back to the
 * exact request that produced it.
 */
export const requestIdMiddleware = async (ctx: Context, next: Next) => {
  const incoming = ctx.headers?.['x-request-id'];
  const requestId =
    typeof incoming === 'string' && incoming.length > 0
      ? incoming
      : randomUUID();

  ctx.state = ctx.state ?? {};
  ctx.state.requestId = requestId;
  ctx.set('X-Request-Id', requestId);

  await next();
};
