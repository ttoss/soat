import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError, type ErrorCode } from '../errors';
import { createGeneration } from './agentGeneration';
import type { GenerationResult } from './agentGenerationTypes';
import { assertDeciderAgentToolLess } from './deciderAgent';
import { renderDeciderFrame } from './deciderFrame';
import {
  compileAnswerSchema,
  DECIDER_USAGE_SOURCE,
  type DeciderQuestions,
  toDecisionAnswers,
} from './deciderQuestions';
import { deciderQuestionsOf, deciders } from './deciders';
import { emitResourceEvent } from './eventBus';
import { paginatedList, type PaginatedResult } from './pagination';
import { isPlainObject } from './plainObject';
import { assertProjectAcceptsWork } from './projectPause';
import { quotaBreachError } from './quotaBreach';
import { checkGenerationQuota } from './quotaEnforcement';
import { makeResourceAccessor } from './resourceAccessor';

const log = createDebug('soat:decisions');

/**
 * Evaluating a decision and recording it.
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
    status: row.status,
    answers: row.answers,
    error: row.error,
    generation_id: row.generationId,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export type MappedDecision = ReturnType<typeof mapDecision>;

type Outcome =
  | {
      status: 'completed';
      answers: Record<string, unknown>;
      generationId: string;
    }
  | { status: 'failed'; error: { code: ErrorCode; message: string } };

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
  outcome: Outcome;
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
 * Its state is not stored, so there is nothing to re-run. Returns whether this
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

/** The generation's own code when it raised one; anything else is opaque. */
const failedOutcome = (error: unknown): Outcome => {
  const { code, message } =
    error instanceof DomainError
      ? error
      : {
          code: 'GENERATION_FAILED' as const,
          message: 'The generation failed.',
        };
  return { status: 'failed', error: { code, message } };
};

/* istanbul ignore next -- a non-streamed generation of a tool-less agent with
   an output schema always completes with an object or throws. */
const answerOf = (
  result: GenerationResult | ReadableStream
): Record<string, unknown> | null => {
  if (result instanceof ReadableStream) return null;
  const object = result.output?.object;
  return isPlainObject(object) ? object : null;
};

const outcomeOf = (args: {
  result: GenerationResult | ReadableStream;
  questions: DeciderQuestions;
}): Outcome => {
  const { result } = args;
  const answer = answerOf(result);
  /* istanbul ignore next -- see `answerOf`. */
  if (answer === null || result instanceof ReadableStream) {
    return failedOutcome(null);
  }
  return {
    status: 'completed',
    answers: toDecisionAnswers({ questions: args.questions, answer }),
    generationId: result.id,
  };
};

/**
 * Runs the agent over the frame and settles the decision. Never throws: a
 * failure after admission is recorded on the decision, since a background
 * caller has no request left to receive it.
 */
const evaluateDecision = async (args: {
  projectIds?: number[];
  decisionDbId: number;
  agentPublicId: string;
  agentVersion: number;
  questions: DeciderQuestions;
  state: unknown;
}): Promise<void> => {
  await db.Decision.update(
    { status: 'running' },
    { where: { id: args.decisionDbId, status: 'queued' } }
  );

  let outcome: Outcome;
  try {
    const result = await createGeneration({
      projectIds: args.projectIds,
      agentId: args.agentPublicId,
      messages: [
        {
          role: 'user',
          content: renderDeciderFrame({
            questions: args.questions,
            state: args.state,
          }),
        },
      ],
      stream: false,
      // The version whose tool surface was checked at admission, so an edit
      // landing mid-evaluation cannot hand the generation a tool.
      pinnedAgentVersion: args.agentVersion,
      source: DECIDER_USAGE_SOURCE,
      outputSchemaOverride: compileAnswerSchema(args.questions),
    });
    outcome = outcomeOf({ result, questions: args.questions });
  } catch (error) {
    outcome = failedOutcome(error);
  }

  await settleDecision({ decisionDbId: args.decisionDbId, outcome });
};

export const createDecision = async (args: {
  projectIds?: number[];
  deciderId: string;
  state: unknown;
  metadata?: Record<string, unknown>;
  wait: boolean;
}): Promise<MappedDecision> => {
  log('createDecision: deciderId=%s wait=%s', args.deciderId, args.wait);

  const decider = await deciders.getByPublicId({
    projectIds: args.projectIds,
    id: args.deciderId,
  });
  assertDeciderAgentToolLess(decider.agent);
  const questions = deciderQuestionsOf(decider);
  await assertProjectAcceptsWork({ projectId: decider.projectId });
  const breach = await checkGenerationQuota({
    agentId: decider.agent.publicId,
    projectIds: args.projectIds,
  });
  if (breach) throw quotaBreachError(breach);

  const decision = await db.Decision.create({
    projectId: decider.projectId,
    deciderId: decider.publicId,
    deciderVersion: decider.version,
    status: 'queued',
    metadata: args.metadata ?? null,
    leaseExpiresAt: new Date(Date.now() + DECISION_LEASE_MS),
  });
  log('createDecision: created id=%s', decision.publicId);

  const evaluate = () => {
    return evaluateDecision({
      projectIds: args.projectIds,
      decisionDbId: decision.id as number,
      agentPublicId: decider.agent.publicId,
      agentVersion: decider.agent.version,
      questions,
      state: args.state,
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
    log('createDecision: evaluation failed id=%s %o', decision.publicId, error);
  });
  return queued;
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
