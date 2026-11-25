/**
 * The only writer of a generation's terminal or paused status.
 *
 * A settle is one conditional write: the row must still be `running` under the
 * lease the writer holds (or, for the sweep, a lease that lapsed). Whoever
 * loses it does nothing else, so a generation settles once and every side
 * effect of settling (the lifecycle event, the chain and session bookkeeping,
 * the writes a caller hands in) happens once.
 */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { toCitationPointers, type TurnCitations } from './citations';
import { noteChainMemberSettled } from './generationChains';
import { suppressContentWrites } from './generationContentSuppression';
import {
  emitGenerationEvent,
  type GenerationRequiredActionWire,
} from './generationEvents';
import { appendGenerationSettled } from './generationProgress';
import { provenanceStatusUpdates } from './generationProvenance';
import {
  endGenerationSegment,
  NO_GENERATION_LEASE,
  segmentLeaseToken,
} from './generationSegment';

const log = createDebug('soat:generation');

export type SettleOutcome =
  | {
      status: 'completed';
      stopReason: string | null;
      /** The final text, announced with `generations.completed`. */
      assistantContent: string;
      /** What a citing turn's answer cited; null for a turn that does not. */
      citations: TurnCitations | null;
    }
  | { status: 'failed'; error: Record<string, unknown> }
  | {
      status: 'requires_action';
      pendingState: Record<string, unknown>;
      requiredAction: GenerationRequiredActionWire;
    };

/** A running row whose lease lapsed. */
const expiredLeaseWhere = (now: Date) => {
  return { status: 'running', leaseExpiresAt: { [Op.lt]: now } };
};

/** The oldest `limit` generations whose lease lapsed by `now`. */
export const findExpiredGenerations = async (args: {
  now: Date;
  limit: number;
}): Promise<Array<{ generationId: string; tracePublicId: string }>> => {
  const rows = await db.Generation.findAll({
    where: expiredLeaseWhere(args.now),
    attributes: ['publicId'],
    include: [{ model: db.Trace, as: 'trace', attributes: ['publicId'] }],
    order: [['createdAt', 'ASC']],
    limit: args.limit,
  });
  return rows.map((row) => {
    return { generationId: row.publicId, tracePublicId: row.trace.publicId };
  });
};

const outcomeColumns = (outcome: SettleOutcome): Record<string, unknown> => {
  if (outcome.status === 'requires_action') {
    return { lastActivityAt: new Date(), pendingState: outcome.pendingState };
  }
  if (outcome.status === 'failed') {
    return {
      completedAt: new Date(),
      stopReason: 'error',
      error: outcome.error,
    };
  }
  return {
    completedAt: new Date(),
    stopReason: outcome.stopReason,
    ...(outcome.citations
      ? { citations: toCitationPointers(outcome.citations.citations) }
      : {}),
  };
};

const emitSettled = (args: {
  outcome: SettleOutcome;
  projectId: number;
  generationId: string;
}): Promise<void> => {
  const { outcome, projectId, generationId } = args;
  if (outcome.status === 'requires_action') {
    return emitGenerationEvent({
      type: 'generations.requires_action',
      projectId,
      generationId,
      requiredAction: outcome.requiredAction,
    });
  }
  if (outcome.status === 'failed') {
    return emitGenerationEvent({
      type: 'generations.failed',
      projectId,
      generationId,
    });
  }
  return emitGenerationEvent({
    type: 'generations.completed',
    projectId,
    generationId,
    assistantContent: outcome.assistantContent,
  });
};

/**
 * Frees the session's busy mark when this turn set it: a mark set after this
 * generation was created belongs to a turn that superseded it.
 */
const releaseSession = async (args: {
  sessionDbId: number | null;
  createdAt: Date;
}): Promise<void> => {
  if (args.sessionDbId === null) return;
  await db.Session.update(
    { generatingAt: null },
    {
      where: {
        id: args.sessionDbId,
        generatingAt: { [Op.lte]: args.createdAt },
      },
    }
  );
};

/**
 * The rows a settle may write: still running under this process's lease, or,
 * for the sweep, under a lease that lapsed. Null when this process runs no
 * segment of the generation.
 */
const fenceWhere = (args: {
  generationId: string;
  fence: 'lease' | 'expired';
  now?: Date;
}) => {
  if (args.fence === 'expired') {
    return expiredLeaseWhere(args.now ?? new Date());
  }
  const token = segmentLeaseToken(args.generationId);
  return token === undefined ? null : { status: 'running', leaseToken: token };
};

const settledColumns = async (args: {
  gen: InstanceType<(typeof db)['Generation']>;
  outcome: SettleOutcome;
}): Promise<Record<string, unknown>> => {
  const { gen, outcome } = args;
  const updates: Record<string, unknown> = {
    status: outcome.status,
    ...outcomeColumns(outcome),
    ...NO_GENERATION_LEASE,
  };
  await suppressContentWrites({
    agentDbId: gen.agentId,
    projectDbId: gen.projectId,
    alreadyRedacted: gen.contentRedactedAt !== null,
    updates,
  });
  return {
    ...updates,
    ...provenanceStatusUpdates({
      generationId: gen.publicId,
      status: outcome.status,
    }),
  };
};

/**
 * The `.catch` of a settle whose caller already holds its answer: the failure
 * is logged and the settle answers `false`, so the caller never throws for it.
 */
export const logSettleFailure = (generationId: string) => {
  return (error: unknown): false => {
    log('settleGeneration: failed generationId=%s %o', generationId, error);
    return false;
  };
};

/**
 * Settles `generationId` with `outcome`. `fence: 'lease'` (the running
 * segment) needs this process's lease token; `fence: 'expired'` (the sweep)
 * needs a lapsed lease. `effects` are writes only the winner makes, awaited
 * before the event announces the record. True when this call settled it.
 */
export const settleGeneration = async (args: {
  generationId: string;
  outcome: SettleOutcome;
  fence: 'lease' | 'expired';
  /** The sweep's clock, against which a lease counts as lapsed. */
  now?: Date;
  effects?: () => Array<Promise<unknown>>;
}): Promise<boolean> => {
  const { generationId, outcome } = args;
  const fence = fenceWhere(args);
  if (!fence) {
    log('settleGeneration: no segment generationId=%s', generationId);
    return false;
  }

  const gen = await db.Generation.findOne({
    where: { publicId: generationId },
  });
  if (!gen) return false;

  const updates = await settledColumns({ gen, outcome });
  const settled = await db.sequelize.transaction(async (transaction) => {
    const [count] = await db.Generation.update(updates, {
      where: { [Op.and]: [{ publicId: generationId }, fence] },
      transaction,
    });
    if (count > 0) {
      await appendGenerationSettled({
        generationDbId: gen.id as number,
        status: outcome.status,
        transaction,
      });
    }
    return count;
  });
  // Won or lost, the segment's run is over; a write that threw keeps it, so
  // the failure path can still settle.
  if (args.fence === 'lease') endGenerationSegment({ generationId });
  log(
    'settleGeneration: generationId=%s status=%s fence=%s settled=%d',
    generationId,
    outcome.status,
    args.fence,
    settled
  );
  if (settled === 0) return false;

  noteChainMemberSettled({
    rootGenerationId: gen.rootGenerationId,
    status: outcome.status,
  });
  await Promise.allSettled([
    releaseSession({ sessionDbId: gen.sessionId, createdAt: gen.createdAt }),
    ...(args.effects?.() ?? []),
  ]);
  await emitSettled({ outcome, projectId: gen.projectId, generationId });
  return true;
};
