import type { ServerResponse } from 'node:http';

import createDebug from 'debug';

import type { Context } from '../Context';
import {
  INTERNAL_FAILURE,
  type StoredError,
  toStoredError,
} from './storedError';

const log = createDebug('soat:sse');

/** Comment frames keep idle proxies from closing a quiet stream. */
export const SSE_HEARTBEAT_MS = 15_000;

/** A stream closes after this long; the reconnect is authorized again. */
export const SSE_MAX_LIFETIME_MS = 5 * 60_000;

/**
 * One frame's payload. `id` marks a durable frame a reconnect resumes after;
 * a transient frame (a text delta) carries none.
 */
export type SseFrame = { data: unknown; id?: string; event?: string };

/** Where a stream closed by its lifetime resumes, e.g. `{ generation_id }`. */
export type SseResume = Record<string, unknown>;

const formatFrame = (frame: SseFrame): string => {
  const id = frame.id === undefined ? '' : `id: ${frame.id}\n`;
  const event = frame.event === undefined ? '' : `event: ${frame.event}\n`;
  return `${id}${event}data: ${JSON.stringify(frame.data)}\n\n`;
};

type Outcome =
  | { kind: 'completed' }
  | { kind: 'failed'; error: StoredError }
  | { kind: 'expired' }
  | { kind: 'disconnected' };

const closingFrame = (args: {
  outcome: Outcome;
  resume?: SseResume;
}): string | null => {
  const { outcome } = args;
  if (outcome.kind === 'completed') return 'data: [DONE]\n\n';
  if (outcome.kind === 'failed') {
    return formatFrame({ data: { error: outcome.error } });
  }
  if (outcome.kind === 'expired') {
    return formatFrame({
      event: 'end',
      data: { reason: 'max_lifetime', ...args.resume },
    });
  }
  return null;
};

/**
 * Serves `frames` as Server-Sent Events: the one place a response is written
 * as `text/event-stream`. A completed source ends with `data: [DONE]`; a
 * failed one with `data: {"error": StoredError}` (a `DomainError` as
 * thrown, anything else `INTERNAL_ERROR`) and no `[DONE]`; a stream
 * outliving `maxLifetimeMs` with an `end` event carrying `resume`. Once the
 * client leaves or the lifetime ends, the source is still drained unwritten,
 * so the work behind it settles as it would have.
 */
export const pipeSse = async (args: {
  res: ServerResponse;
  frames: AsyncIterable<SseFrame>;
  /** Names the stream in the log line an unexpected failure writes. */
  label: string;
  resume?: SseResume;
  heartbeatMs?: number;
  maxLifetimeMs?: number;
}): Promise<void> => {
  const { res } = args;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Headers otherwise wait for the first frame, which a model may take long
  // to produce.
  res.flushHeaders();

  let stopped: Outcome | null = null;
  const timers: { heartbeat?: NodeJS.Timeout; lifetime?: NodeJS.Timeout } = {};
  const stop = (outcome: Outcome) => {
    if (stopped) return;
    stopped = outcome;
    clearInterval(timers.heartbeat);
    clearTimeout(timers.lifetime);
    const frame = closingFrame({ outcome, resume: args.resume });
    log('pipeSse: closing outcome=%s', outcome.kind);
    if (frame && !res.writableEnded) res.write(frame);
    res.end();
  };

  timers.heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, args.heartbeatMs ?? SSE_HEARTBEAT_MS);
  timers.lifetime = setTimeout(() => {
    stop({ kind: 'expired' });
  }, args.maxLifetimeMs ?? SSE_MAX_LIFETIME_MS);
  // `res`, not `req`: a request's `close` fires once its body is read.
  const onClose = () => {
    stop({ kind: 'disconnected' });
  };
  res.on('close', onClose);

  try {
    for await (const frame of args.frames) {
      if (!stopped) res.write(formatFrame(frame));
    }
    stop({ kind: 'completed' });
  } catch (error) {
    stop({
      kind: 'failed',
      error: toStoredError({
        error,
        opaque: INTERNAL_FAILURE,
        label: args.label,
      }),
    });
  } finally {
    res.off('close', onClose);
  }
};

/** {@link pipeSse} as a Koa route's whole answer. */
export const serveSse = async (
  args: Omit<Parameters<typeof pipeSse>[0], 'res'> & {
    ctx: Context;
  }
): Promise<void> => {
  const { ctx, ...rest } = args;
  ctx.respond = false;
  await pipeSse({ ...rest, res: ctx.res });
};
