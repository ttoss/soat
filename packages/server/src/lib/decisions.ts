import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  answersByName,
  type DeciderQuestions,
  parseDeciderQuestions,
} from './deciderQuestions';
import { deciderQuestionSetAt } from './deciderQuestionSet';
import { deciders, resolveDeciderBackend } from './deciders';
import {
  admitDecisionBackend,
  type DecisionEvaluation,
  type DecisionOutcome,
  failedOutcome,
} from './decisionBackends';
import { emitResourceEvent } from './eventBus';
import { paginatedList, type PaginatedResult } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';

const log = createDebug('soat:decisions');

/**
 * Evaluating a decision and recording it, for a decider or for questions sent
 * with the request.
 *
 * Everything that can refuse a request runs before the row is written, so a
 * refusal is a `4xx` and never a polled failure. The row then settles exactly
 * once, through {@link settleDecision} or {@link interruptDecision}; this
 * module is the only writer of `answers`.
 */

export const DECISION_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;

const UNSETTLED_STATUSES = ['queued', 'running'];

/**
 * How long the evaluating process owns an unsettled decision. Past it, the
 * sweep in `decisionsScheduler.ts` settles the decision as interrupted.
 */
export const DECISION_LEASE_MS = 15 * 60 * 1000;

type DecisionRow = InstanceType<(typeof db)['Decision']> & {
  project: { publicId: string };
};

const decisionIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

export const decisions = makeResourceAccessor<DecisionRow>({
  model: () => {
    return db.Decision;
  },
  includes: decisionIncludes,
  label: 'Decision',
});

export const mapDecision = (row: DecisionRow) => {
  return {
    id: row.publicId,
    project_id: row.project.publicId,
    decider_id: row.deciderId,
    decider_version: row.deciderVersion,
    questions: row.questions,
    status: row.status,
    answers: row.answers,
    answers_by_name: answersByName(row.answers),
    error: row.error,
    generation_id: row.generationId,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export type MappedDecision = ReturnType<typeof mapDecision>;

/** Fires the settled decision's event, carrying the decision as read now. */
export const announceDecision = async (args: {
  decisionDbId: number;
}): Promise<void> => {
  const row = await decisions.reload({ id: args.decisionDbId });
  emitResourceEvent({
    type:
      row.status === 'completed' ? 'decisions.completed' : 'decisions.failed',
    projectId: row.projectId,
    projectPublicId: row.project.publicId,
    resourceType: 'decision',
    resourceId: row.publicId,
    data: mapDecision(row),
  });
};

/**
 * Writes the outcome while the decision is still unsettled. A second writer —
 * the sweep that interrupted it, or a redelivery — finds nothing to update, so
 * a recorded answer is never overwritten.
 */
const settleDecision = async (args: {
  decisionDbId: number;
  outcome: DecisionOutcome;
}): Promise<void> => {
  const { outcome } = args;
  const [updated] = await db.Decision.update(
    outcome.status === 'completed'
      ? {
          status: 'completed',
          answers: outcome.answers,
          generationId: outcome.generationId,
          leaseExpiresAt: null,
        }
      : { status: 'failed', error: outcome.error, leaseExpiresAt: null },
    { where: { id: args.decisionDbId, status: UNSETTLED_STATUSES } }
  );
  log(
    'settleDecision: id=%d status=%s written=%s',
    args.decisionDbId,
    outcome.status,
    updated > 0
  );
  if (updated > 0) await announceDecision(args);
};

/**
 * Settles, as interrupted, a decision whose lease ran out before it settled.
 * Its input is not stored, so there is nothing to re-run. Returns whether this
 * call won the write.
 */
export const interruptDecision = async (args: {
  decisionDbId: number;
  now: Date;
}): Promise<boolean> => {
  const [updated] = await db.Decision.update(
    {
      status: 'failed',
      error: {
        code: 'DECISION_INTERRUPTED',
        message:
          'The decision was not settled before its lease expired; request a new one.',
      },
      leaseExpiresAt: null,
    },
    {
      where: {
        id: args.decisionDbId,
        status: UNSETTLED_STATUSES,
        leaseExpiresAt: { [Op.lt]: args.now },
      },
    }
  );
  log('interruptDecision: id=%d written=%s', args.decisionDbId, updated > 0);
  return updated > 0;
};

/**
 * Runs the backend and settles the decision. Never throws: a failure after
 * admission is recorded on the decision, since a background caller has no
 * request left to receive it.
 */
const evaluateDecision = async (args: {
  decisionDbId: number;
  evaluation: DecisionEvaluation;
}): Promise<void> => {
  await db.Decision.update(
    { status: 'running' },
    { where: { id: args.decisionDbId, status: 'queued' } }
  );

  let outcome: DecisionOutcome;
  try {
    outcome = await args.evaluation.answer();
  } catch (error) {
    outcome = failedOutcome({
      error,
      opaque: args.evaluation.opaqueFailure,
    });
  }

  await settleDecision({ decisionDbId: args.decisionDbId, outcome });
};

/** Writes the admitted decision, then evaluates it now or in the background. */
const recordAndEvaluate = async (args: {
  projectId: number;
  deciderId: string | null;
  deciderVersion: number | null;
  questions: DeciderQuestions | null;
  metadata?: Record<string, unknown>;
  wait: boolean;
  evaluation: DecisionEvaluation;
}): Promise<MappedDecision> => {
  const decision = await db.Decision.create({
    projectId: args.projectId,
    deciderId: args.deciderId,
    deciderVersion: args.deciderVersion,
    questions: args.questions,
    status: 'queued',
    metadata: args.metadata ?? null,
    leaseExpiresAt: new Date(Date.now() + DECISION_LEASE_MS),
  });
  log('recordAndEvaluate: created id=%s', decision.publicId);

  const evaluate = () => {
    return evaluateDecision({
      decisionDbId: decision.id as number,
      evaluation: args.evaluation,
    });
  };

  if (args.wait) {
    await evaluate();
    return mapDecision(await decisions.reload(decision));
  }

  // Read before the evaluation starts, whose first write moves the row to
  // `running`: the background answer is the decision as it was admitted.
  const queued = mapDecision(await decisions.reload(decision));
  void evaluate().catch((error: unknown) => {
    log(
      'recordAndEvaluate: evaluation failed id=%s %o',
      decision.publicId,
      error
    );
  });
  return queued;
};

export const createDecision = async (args: {
  projectIds?: number[];
  deciderId: string;
  input: unknown;
  metadata?: Record<string, unknown>;
  wait: boolean;
  /**
   * Borrowed, not stored: evaluation never outlives this process, since an
   * interrupted decision is failed rather than re-run.
   */
  authHeader?: string;
  /** Answer under this archived question set rather than the live one. */
  version?: number;
}): Promise<MappedDecision> => {
  log('createDecision: deciderId=%s wait=%s', args.deciderId, args.wait);

  const decider = await deciders.getByPublicId({
    projectIds: args.projectIds,
    id: args.deciderId,
  });
  const questionSet = await deciderQuestionSetAt({
    decider,
    version: args.version,
  });
  const evaluation = await admitDecisionBackend({
    projectIds: args.projectIds,
    projectId: decider.projectId,
    agent: decider.agent,
    tool: decider.tool,
    questions: questionSet.questions,
    input: args.input,
    authHeader: args.authHeader,
  });

  return recordAndEvaluate({
    projectId: decider.projectId,
    deciderId: decider.publicId,
    deciderVersion: questionSet.version,
    questions: null,
    metadata: args.metadata,
    wait: args.wait,
    evaluation,
  });
};

/**
 * A decision whose questions come with the request rather than from a
 * decider, answered by the agent or tool the request names. The questions are
 * stored on the decision, since no version names them.
 */
export const createInlineDecision = async (args: {
  projectId: number;
  agentId?: unknown;
  toolId?: unknown;
  questions: unknown;
  input: unknown;
  metadata?: Record<string, unknown>;
  wait: boolean;
  authHeader?: string;
}): Promise<MappedDecision> => {
  log('createInlineDecision: projectId=%d wait=%s', args.projectId, args.wait);

  const questions = parseDeciderQuestions(args.questions);
  const backend = await resolveDeciderBackend({
    projectId: args.projectId,
    agentId: args.agentId,
    toolId: args.toolId,
  });
  const evaluation = await admitDecisionBackend({
    projectIds: [args.projectId],
    projectId: args.projectId,
    ...backend,
    questions,
    input: args.input,
    authHeader: args.authHeader,
  });

  return recordAndEvaluate({
    projectId: args.projectId,
    deciderId: null,
    deciderVersion: null,
    questions,
    metadata: args.metadata,
    wait: args.wait,
    evaluation,
  });
};

const readStatusFilter = (status: unknown): string | undefined => {
  if (status === undefined) return undefined;
  if (
    typeof status !== 'string' ||
    !DECISION_STATUSES.some((known) => {
      return known === status;
    })
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `status must be one of ${DECISION_STATUSES.join(', ')}.`
    );
  }
  return status;
};

export const listDecisions = async (args: {
  projectIds?: number[];
  deciderId?: string;
  status?: unknown;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedDecision>> => {
  log('listDecisions: projectIds=%o', args.projectIds);
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) where.projectId = args.projectIds;
  if (args.deciderId !== undefined) where.deciderId = args.deciderId;
  const status = readStatusFilter(args.status);
  if (status !== undefined) where.status = status;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.Decision.findAndCountAll({
        where,
        include: decisionIncludes(),
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapDecision(row as DecisionRow);
    },
  });
};

export const getDecision = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedDecision> => {
  log('getDecision: id=%s', args.id);
  return mapDecision(await decisions.getByPublicId(args));
};
