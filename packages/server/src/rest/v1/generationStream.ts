import createDebug from 'debug';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { acceptTurn } from 'src/lib/acceptedTurn';
import {
  followGenerationEvents,
  type GenerationEvent,
} from 'src/lib/generationEventFeed';
import { getGenerationTraceId } from 'src/lib/generations';
import { readsShowing } from 'src/lib/permissionCatalog';
import { serveSse, type SseFrame } from 'src/lib/sse';
import { traceRows } from 'src/lib/traces';

import { loggableError } from '../../lib/loggableError';
import { authorizeResource } from './resourceAccess';

const log = createDebug('soat:generation-stream');

/**
 * Whether this request blocks. Background is the default; a stream holds the
 * request open by definition, so `stream: true` implies waiting, and asking
 * for both a stream and a background run is refused rather than resolved
 * either way.
 */
export const resolveStreamWait = (args: {
  ctx: Context;
  stream?: boolean;
}): boolean => {
  const requested = args.ctx.query['wait'];
  if (args.stream === true && requested === 'false') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'stream and wait=false are mutually exclusive: a streamed generation must hold the request open.'
    );
  }
  return requested === 'true' || args.stream === true;
};

/**
 * A generation's step content is its trace's: reading it needs
 * `traces:GetTrace` on the trace, beside whatever reached the generation. The
 * refusal is `403`, not a hide: the generation read already succeeded. `omit`
 * answers `false` instead, for a stream that serves progress rows without it.
 */
export const authorizeGenerationContent = async (args: {
  ctx: Context;
  generationId: string;
  onDenied: 'refuse' | 'omit';
}): Promise<boolean> => {
  const traceId = await getGenerationTraceId({ id: args.generationId });
  try {
    await authorizeResource({
      ctx: args.ctx,
      scope: await traceRows.findScope({ id: traceId }),
      resourceType: 'trace',
      shownBy: readsShowing({ module: 'traces', noun: 'Trace' }),
      resourceId: traceId,
      label: 'Trace',
      action: 'traces:GetTrace',
      onDenied: 'refuse',
    });
    return true;
  } catch (error) {
    if (
      args.onDenied === 'omit' &&
      error instanceof DomainError &&
      error.httpStatus === 403
    ) {
      return false;
    }
    throw error;
  }
};

/** A progress row as a durable frame: its `seq` is the reconnect cursor. */
export const progressFrame = (event: GenerationEvent): SseFrame => {
  return { id: String(event.seq), event: 'progress', data: event };
};

/**
 * Serves the generation's events after `afterSeq` as SSE until it settles,
 * after `prelude`. A stream closed by its lifetime ends with the cursor to
 * reconnect from.
 */
export const serveGenerationEvents = async (args: {
  ctx: Context;
  generationId: string;
  afterSeq: number;
  includeContent: boolean;
  label: string;
  prelude?: SseFrame[];
}): Promise<void> => {
  const resume = { generation_id: args.generationId, after_seq: args.afterSeq };
  await serveSse({
    ctx: args.ctx,
    label: args.label,
    resume,
    async *frames(stopped) {
      yield* args.prelude ?? [];
      for await (const event of followGenerationEvents({
        generationId: args.generationId,
        afterSeq: args.afterSeq,
        includeContent: args.includeContent,
        signal: stopped,
      })) {
        resume.after_seq = event.seq;
        yield progressFrame(event);
      }
    },
  });
};

/**
 * `frames` interleaved with the generation's progress rows, as `progress`
 * frames without step content. The last of `frames` (the result or error
 * frame) is held until the progress rows end, so it stays the last frame; the
 * progress half reads once more after `frames` ends, when the run has settled.
 */
export async function* withProgressFrames(args: {
  frames: AsyncIterable<SseFrame>;
  generationId: string;
}): AsyncGenerator<SseFrame> {
  const drain = new AbortController();
  const stop = new AbortController();
  const queue: SseFrame[] = [];
  // Written by the two pumps, read by the loop below.
  const state: {
    pending: number;
    held: SseFrame | null;
    failure: { error: unknown } | null;
  } = { pending: 2, held: null, failure: null };
  let kick: (() => void) | null = null;
  const wake = () => {
    kick?.();
    kick = null;
  };
  const pumpText = async () => {
    try {
      for await (const frame of args.frames) {
        if (state.held) queue.push(state.held);
        state.held = frame;
        wake();
      }
    } catch (error) {
      state.failure = { error };
    } finally {
      drain.abort();
      state.pending -= 1;
      wake();
    }
  };
  const pumpProgress = async () => {
    try {
      for await (const event of followGenerationEvents({
        generationId: args.generationId,
        afterSeq: 0,
        includeContent: false,
        signal: stop.signal,
        drain: drain.signal,
      })) {
        queue.push(progressFrame(event));
        wake();
      }
    } catch (error) {
      // Progress rows are additive: the text stream still ends on its own.
      log('withProgressFrames: progress failed: %o', loggableError(error));
    } finally {
      state.pending -= 1;
      wake();
    }
  };
  void pumpText();
  void pumpProgress();
  try {
    for (;;) {
      const frame = queue.shift();
      if (frame) {
        yield frame;
        continue;
      }
      if (state.pending === 0) {
        if (state.held) yield state.held;
        if (state.failure) throw state.failure.error;
        return;
      }
      await new Promise<void>((resolve) => {
        kick = resolve;
      });
    }
  } finally {
    stop.abort();
  }
}

/**
 * A turn started with `stream: true`: an `accepted` frame naming the handle,
 * then the generation's events. Step content needs `traces:GetTrace`, as on
 * the events route; without it the stream carries progress rows only.
 */
const serveTurnStream = async (args: {
  ctx: Context;
  generationId: string;
  accepted: Record<string, unknown>;
  label: string;
}): Promise<void> => {
  const includeContent = await authorizeGenerationContent({
    ctx: args.ctx,
    generationId: args.generationId,
    onDenied: 'omit',
  });
  await serveGenerationEvents({
    ctx: args.ctx,
    generationId: args.generationId,
    afterSeq: 0,
    includeContent,
    label: args.label,
    prelude: [{ event: 'accepted', data: args.accepted }],
  });
};

/**
 * Answers a turn that does not block: once its record exists, the `202`
 * handle, or with `stream` that handle's stream. `handle` names the resource
 * the turn belongs to (`{ session_id }`).
 */
export const respondAcceptedTurn = async (args: {
  ctx: Context;
  stream: boolean;
  handle: Record<string, string>;
  label: string;
  start: Parameters<typeof acceptTurn>[0]['start'];
}): Promise<void> => {
  const { ctx } = args;
  const ids = await acceptTurn({ start: args.start });
  const accepted = {
    status: 'accepted',
    ...args.handle,
    generation_id: ids.generationId,
    trace_id: ids.traceId,
  };
  if (args.stream) {
    await serveTurnStream({
      ctx,
      generationId: ids.generationId,
      accepted,
      label: args.label,
    });
    return;
  }
  ctx.status = 202;
  ctx.body = accepted;
};
