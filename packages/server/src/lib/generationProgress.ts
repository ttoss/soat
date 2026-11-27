/**
 * A generation's progress rows: the facts its instrumentation records while it
 * runs. `generationInstrumentation.ts` records steps and tool calls; the
 * lifecycle rows are written in the transaction of the write they describe
 * (`generations.ts`, `generationSettle.ts`).
 */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { lockForTransaction } from './advisoryLocks';
import type { Transaction } from './dbTransaction';
import { notifyGenerationProgress } from './generationWakeup';
import { loggableError } from './loggableError';
import {
  type ListFilters,
  type Page,
  type PageRequest,
  paginatedList,
} from './pagination';
import type { MarkedToolCallStatus } from './toolCallOutcome';

const log = createDebug('soat:generation-progress');

export const PROGRESS_EVENT_TYPES = [
  'generations.started',
  'generations.completed',
  'generations.failed',
  'generations.requires_action',
  'generations.step_started',
  'generations.step_ended',
  'generations.tool_call_started',
  'generations.tool_call_ended',
  'generations.sub_generation_started',
] as const;

export type ProgressEventType = (typeof PROGRESS_EVENT_TYPES)[number];

/** How a tool call ended: it ran, it threw, or something answered for it. */
export type ToolCallStatus = 'executed' | MarkedToolCallStatus;

export type ProgressFact = {
  type: ProgressEventType;
  stepIndex?: number | null;
  toolCallId?: string | null;
  status?: string | null;
  durationMs?: number | null;
  childGenerationId?: string | null;
};

/**
 * Appends `fact` to the generation's rows inside `transaction`. The lock on
 * the generation makes `seq` allocation and commit one ordered sequence, so a
 * reader never sees a higher `seq` while a lower one is uncommitted.
 */
export const appendProgressEvent = async (args: {
  generationDbId: number;
  fact: ProgressFact;
  transaction: Transaction;
}): Promise<void> => {
  const { generationDbId, fact, transaction } = args;
  log('appendProgressEvent: generation=%d type=%s', generationDbId, fact.type);
  await lockForTransaction({
    sequelize: db.sequelize,
    transaction,
    namespace: 'generationProgress',
    id: generationDbId,
  });
  const last: unknown = await db.GenerationProgressEvent.max('seq', {
    where: { generationId: generationDbId },
    transaction,
  });
  await db.GenerationProgressEvent.create(
    {
      generationId: generationDbId,
      seq: (typeof last === 'number' ? last : 0) + 1,
      type: fact.type,
      stepIndex: fact.stepIndex ?? null,
      toolCallId: fact.toolCallId ?? null,
      status: fact.status ?? null,
      durationMs: fact.durationMs ?? null,
      childGenerationId: fact.childGenerationId ?? null,
    },
    { transaction }
  );
  await notifyGenerationProgress({ generationDbId, transaction });
};

/**
 * Appends `fact` in a transaction of its own. Never throws: a progress row
 * that fails to land must not fail the generation it describes.
 */
export const recordProgress = async (args: {
  generationId: string;
  fact: ProgressFact;
}): Promise<void> => {
  try {
    await db.sequelize.transaction(async (transaction) => {
      const gen = await db.Generation.findOne({
        where: { publicId: args.generationId },
        attributes: ['id'],
        transaction,
      });
      if (!gen) return;
      await appendProgressEvent({
        generationDbId: gen.id as number,
        fact: args.fact,
        transaction,
      });
    });
  } catch (error) {
    log(
      'recordProgress: failed generationId=%s type=%s %o',
      args.generationId,
      args.fact.type,
      loggableError(error)
    );
  }
};

export type InFlightToolCall = {
  tool_call_id: string | null;
  step_index: number | null;
  started_at: Date;
};

/** The tool calls that started and have not ended, in start order. */
export const findInFlightToolCalls = async (args: {
  generationDbId: number;
}): Promise<InFlightToolCall[]> => {
  const rows = await db.GenerationProgressEvent.findAll({
    where: {
      generationId: args.generationDbId,
      type: ['generations.tool_call_started', 'generations.tool_call_ended'],
    },
    order: [['seq', 'ASC']],
  });
  const open = new Map<string, InFlightToolCall>();
  for (const row of rows) {
    const key = row.toolCallId ?? `seq:${row.seq}`;
    if (row.type === 'generations.tool_call_ended') {
      open.delete(key);
      continue;
    }
    open.set(key, {
      tool_call_id: row.toolCallId,
      step_index: row.stepIndex,
      started_at: row.createdAt,
    });
  }
  return [...open.values()];
};

/** The tool call of another generation that started this one. */
export type ParentToolCall = { generationId: string; toolCallId: string };

/**
 * The rows a new generation's record writes, in its creation transaction: its
 * own `generations.started`, and, when a tool call started it, the pointer in
 * the parent's rows.
 */
export const appendGenerationStarted = async (args: {
  generationDbId: number;
  generationId: string;
  parentCall?: ParentToolCall | null;
  transaction: Transaction;
}): Promise<void> => {
  const { transaction, parentCall } = args;
  await appendProgressEvent({
    generationDbId: args.generationDbId,
    fact: { type: 'generations.started' },
    transaction,
  });
  if (!parentCall) return;
  const parent = await db.Generation.findOne({
    where: { publicId: parentCall.generationId },
    attributes: ['id'],
    transaction,
  });
  if (!parent) return;
  await appendProgressEvent({
    generationDbId: parent.id as number,
    fact: {
      type: 'generations.sub_generation_started',
      toolCallId: parentCall.toolCallId,
      childGenerationId: args.generationId,
    },
    transaction,
  });
};

/** The row each settled status writes; a follower stops after one. */
export const SETTLED_PROGRESS_TYPES = {
  completed: 'generations.completed',
  failed: 'generations.failed',
  requires_action: 'generations.requires_action',
} as const satisfies Record<string, ProgressEventType>;

/** The row a settle writes, in the settle's own transaction. */
export const appendGenerationSettled = (args: {
  generationDbId: number;
  status: keyof typeof SETTLED_PROGRESS_TYPES;
  transaction: Transaction;
}): Promise<void> => {
  return appendProgressEvent({
    generationDbId: args.generationDbId,
    fact: { type: SETTLED_PROGRESS_TYPES[args.status], status: args.status },
    transaction: args.transaction,
  });
};

/** A progress row as it is stored. */
export type ProgressRow = {
  seq: number;
  type: string;
  stepIndex: number | null;
  toolCallId: string | null;
  status: string | null;
  durationMs: number | null;
  childGenerationId: string | null;
  createdAt: Date;
};

/** Up to `limit` of the generation's rows after `afterSeq`, in `seq` order. */
export const readProgressRows = (args: {
  generationDbId: number;
  afterSeq: number;
  limit: number;
}): Promise<ProgressRow[]> => {
  return db.GenerationProgressEvent.findAll({
    where: {
      generationId: args.generationDbId,
      seq: { [Op.gt]: args.afterSeq },
    },
    order: [['seq', 'ASC']],
    limit: args.limit,
  });
};

/** A page of the generation's rows after `afterSeq`; `seq` is its keyset. */
export const pageProgressRows = (
  args: PageRequest & {
    generationDbId: number;
    afterSeq: number;
    filters: ListFilters;
  }
): Promise<Page<ProgressRow>> => {
  log('pageProgressRows: generation=%d', args.generationDbId);
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: args.filters,
    where: {
      generationId: args.generationDbId,
      seq: { [Op.gt]: args.afterSeq },
    },
    order: [['seq', 'ASC']],
    tiebreak: [],
    query: ({ where, limit, order }) => {
      return db.GenerationProgressEvent.findAll({ where, limit, order });
    },
    map: (row): ProgressRow => {
      return row;
    },
  });
};
