/**
 * A generation's transcript, incrementally: its progress rows in `seq` order,
 * each `generations.step_ended` row carrying the step it ended as a
 * `TranscriptStep`. Read as a page, or followed until the generation settles.
 */
import createDebug from 'debug';

import { db } from '../db';
import {
  pageProgressRows,
  type ProgressRow,
  readProgressRows,
  SETTLED_PROGRESS_TYPES,
} from './generationProgress';
import {
  projectTranscriptSteps,
  type TranscriptStep,
} from './generationTranscript';
import {
  type GenerationWithTrace,
  loadGenerationWithTrace,
  readGenerationSteps,
} from './generationTurn';
import { subscribeGenerationProgress } from './generationWakeup';
import type { Page, PageRequest } from './pagination';

const log = createDebug('soat:generation-event-feed');

export type GenerationEvent = {
  seq: number;
  type: string;
  step_index: number | null;
  tool_call_id: string | null;
  status: string | null;
  duration_ms: number | null;
  child_generation_id: string | null;
  created_at: Date;
  /** The ended step, on a `generations.step_ended` row whose content is read. */
  step: TranscriptStep | null;
};

const SETTLED_TYPES: ReadonlySet<string> = new Set(
  Object.values(SETTLED_PROGRESS_TYPES)
);

const FOLLOW_PAGE = 100;
const FOLLOW_POLL_MS = 1_000;

type Row = ProgressRow;

/**
 * The ended steps of `rows`, read from the store on every call: a purge or the
 * content mode is re-read with the generation, so content erased between two
 * reads is never served by the second.
 */
const readEndedSteps = async (args: {
  generationId: string;
  rows: Row[];
  includeContent: boolean;
}): Promise<Map<number, TranscriptStep>> => {
  const ended = new Map<number, TranscriptStep>();
  const wanted = args.rows.some((row) => {
    return row.type === 'generations.step_ended';
  });
  if (!args.includeContent || !wanted) return ended;
  const generation = await loadGenerationWithTrace({
    generationId: args.generationId,
  });
  if (generation.contentRedactedAt !== null) return ended;
  for (const step of projectTranscriptSteps(
    await readGenerationSteps(generation)
  )) {
    ended.set(step.index, step);
  }
  return ended;
};

const toEvents = async (args: {
  generationId: string;
  rows: Row[];
  includeContent: boolean;
}): Promise<GenerationEvent[]> => {
  const steps = await readEndedSteps(args);
  return args.rows.map((row) => {
    const step =
      row.type === 'generations.step_ended' && row.stepIndex !== null
        ? (steps.get(row.stepIndex) ?? null)
        : null;
    return {
      seq: row.seq,
      type: row.type,
      step_index: row.stepIndex,
      tool_call_id: row.toolCallId,
      status: row.status,
      duration_ms: row.durationMs,
      child_generation_id: row.childGenerationId,
      created_at: row.createdAt,
      step,
    };
  });
};

export type GenerationEventsPage = Page<GenerationEvent> & {
  generation_id: string;
  status: string;
};

/** One page of the events after `afterSeq`, in `seq` order. */
export const listGenerationEvents = async (
  args: PageRequest & {
    generationId: string;
    projectIds?: number[];
    afterSeq: number;
    includeContent: boolean;
  }
): Promise<GenerationEventsPage> => {
  log(
    'listGenerationEvents: generationId=%s afterSeq=%d',
    args.generationId,
    args.afterSeq
  );
  const generation: GenerationWithTrace = await loadGenerationWithTrace({
    generationId: args.generationId,
    projectIds: args.projectIds,
  });
  const page = await pageProgressRows({
    limit: args.limit,
    cursor: args.cursor,
    generationDbId: generation.id,
    afterSeq: args.afterSeq,
    filters: {
      generationId: generation.publicId,
      afterSeq: args.afterSeq,
      includeContent: args.includeContent,
    },
  });
  return {
    ...page,
    generation_id: generation.publicId,
    status: generation.status,
    data: await toEvents({
      generationId: generation.publicId,
      rows: page.data,
      includeContent: args.includeContent,
    }),
  };
};

/** Resolves on a wake-up, the poll interval, or either signal. */
const waiter = () => {
  let woken = false;
  let release: (() => void) | null = null;
  const wake = () => {
    woken = true;
    release?.();
  };
  const wait = (signals: AbortSignal[], pollMs: number): Promise<void> => {
    if (woken) {
      woken = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const until = AbortSignal.any([...signals, AbortSignal.timeout(pollMs)]);
      const done = () => {
        until.removeEventListener('abort', done);
        release = null;
        woken = false;
        resolve();
      };
      if (until.aborted) {
        done();
        return;
      }
      until.addEventListener('abort', done, { once: true });
      release = done;
    });
  };
  return { wake, wait };
};

/** One read of a followed generation: its status, then the rows after it. */
const readFollowed = async (args: {
  generationDbId: number;
  generationId: string;
  afterSeq: number;
  includeContent: boolean;
}) => {
  // Status before rows: a settle commits its row with its status, so a status
  // seen settled here guarantees the rows below include that row.
  const current = await db.Generation.findByPk(args.generationDbId, {
    attributes: ['status'],
  });
  const rows = await readProgressRows({
    generationDbId: args.generationDbId,
    afterSeq: args.afterSeq,
    limit: FOLLOW_PAGE,
  });
  return {
    running: current?.status === 'running',
    full: rows.length === FOLLOW_PAGE,
    events: await toEvents({
      generationId: args.generationId,
      rows,
      includeContent: args.includeContent,
    }),
  };
};

/**
 * Follows the events after `afterSeq` until the generation settles or pauses:
 * the stream ends after its `completed`, `failed` or `requires_action` row, or
 * once it no longer runs and has no row left. `signal` stops it at once;
 * `drain` stops it after one more read, for a caller that knows no row is
 * coming.
 */
export async function* followGenerationEvents(args: {
  generationId: string;
  afterSeq: number;
  includeContent: boolean;
  signal?: AbortSignal;
  drain?: AbortSignal;
}): AsyncGenerator<GenerationEvent> {
  const { generationId, includeContent } = args;
  log('followGenerationEvents: generationId=%s', generationId);
  const generation = await loadGenerationWithTrace({ generationId });
  const { wake, wait } = waiter();
  const unsubscribe = subscribeGenerationProgress({
    generationDbId: generation.id,
    wake,
  });
  const signals = [args.signal, args.drain].filter((signal) => {
    return signal !== undefined;
  });
  let cursor = args.afterSeq;
  try {
    while (!args.signal?.aborted) {
      const drained = args.drain?.aborted === true;
      const read = await readFollowed({
        generationDbId: generation.id,
        generationId,
        afterSeq: cursor,
        includeContent,
      });
      for (const event of read.events) {
        yield event;
        cursor = event.seq;
        if (SETTLED_TYPES.has(event.type)) return;
      }
      if (read.full) continue;
      if (!read.running || drained) return;
      await wait(signals, FOLLOW_POLL_MS);
    }
  } finally {
    unsubscribe();
  }
}
