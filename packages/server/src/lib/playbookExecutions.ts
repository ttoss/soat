import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { onEvent, retryOrRecordDrop, type SoatEvent } from './eventBus';
import { paginatedList } from './pagination';
import {
  assertCaseAcceptsWork,
  caseDefinition,
  caseNodeStates,
  playbookCases,
  withLockedCase,
} from './playbookCases';
import type { PlaybookNode } from './playbookDefinition';
import { EXECUTION_LEASE_MS } from './playbookExecutionLease';
import { settleFromRun } from './playbookExecutionSettle';
import { executeClaimed, resolveRunAs } from './playbookExecutionWork';
import { executorInput } from './playbookExecutors';
import { nodesByKey } from './playbookGraph';
import type { PlaybookNodeView } from './playbookState';
import { assertProjectAcceptsWork } from './projectPause';

const log = createDebug('soat:playbookExecutions');

type ExecutionRow = InstanceType<(typeof db)['PlaybookExecution']> & {
  createdBy?: { publicId: string } | null;
};

export const mapPlaybookExecution = (args: {
  row: ExecutionRow;
  casePublicId: string;
}) => {
  const { row } = args;
  return {
    id: row.publicId,
    case_id: args.casePublicId,
    node: row.node,
    playbook_version: row.playbookVersion,
    executor: row.executorType
      ? { type: row.executorType, id: row.executorId }
      : null,
    status: row.status,
    result: row.result,
    run_id: row.runId,
    input: row.input,
    output: row.output ?? null,
    output_revision: row.outputRevision,
    error: row.error,
    created_by: row.createdBy?.publicId ?? null,
    created_at: row.createdAt,
    finished_at: row.finishedAt,
  };
};

// `done` runs on request only: the cascade never reruns a current output, and
// an equal output writes no revision, so nothing downstream reruns either.
const RUNNABLE_STATES: ReadonlySet<string> = new Set([
  'ready',
  'stale',
  'failed',
  'done',
]);

/** A node runs when its inputs are set and nothing of it is in flight. */
const assertRunnable = (args: {
  node: PlaybookNode;
  view: PlaybookNodeView;
}): void => {
  const { node, view } = args;
  const blocked = view.missing.length > 0 || view.blockedBy.length > 0;
  if (node.kind !== 'confirm' && !blocked && RUNNABLE_STATES.has(view.state)) {
    return;
  }
  throw new DomainError(
    'PLAYBOOK_NODE_NOT_RUNNABLE',
    node.kind === 'confirm'
      ? `Node '${node.key}' is settled by a confirmation, not a run.`
      : `Node '${node.key}' is ${view.state} and cannot run now.`,
    {
      node: node.key,
      state: view.state,
      missing: view.missing,
      blocked_by: view.blockedBy,
    }
  );
};

/** The node of the case's version a route names. */
export const readCaseNode = (args: {
  definition: Parameters<typeof nodesByKey>[0]['definition'];
  node: unknown;
}): PlaybookNode => {
  const found =
    typeof args.node === 'string'
      ? nodesByKey({ definition: args.definition }).get(args.node)
      : undefined;
  if (!found) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `node must name a node of the case's playbook version.`,
      { node: args.node }
    );
  }
  return found;
};

export const getPlaybookCaseExecution = async (args: {
  projectIds?: number[];
  caseId: string;
  id: string;
}) => {
  log('getPlaybookCaseExecution: id=%s', args.id);
  const row = await playbookCases.getByPublicId({
    projectIds: args.projectIds,
    id: args.caseId,
  });
  const execution = await db.PlaybookExecution.findOne({
    where: { publicId: args.id, caseId: row.id as number },
    include: [{ model: db.User, as: 'createdBy' }],
  });
  if (!execution) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Playbook execution '${args.id}' not found.`
    );
  }
  return mapPlaybookExecution({
    row: execution as ExecutionRow,
    casePublicId: row.publicId,
  });
};

/** An execution nothing awaits; settling never throws back at the caller. */
const executeInBackground = async (args: {
  executionId: number;
}): Promise<void> => {
  try {
    await executeClaimed(args);
  } catch (error) {
    log('executeInBackground: %d did not settle: %o', args.executionId, error);
  }
};

/**
 * Runs one node of a case now. Everything a refusal depends on — the node,
 * its state, the author and the author's permission — is checked before the
 * execution is recorded. Without `wait` it answers `running` and settles in
 * the background; with it, it answers once the executor settles or parks on a
 * task or a run that settles it later.
 */
export const runPlaybookNode = async (args: {
  projectIds?: number[];
  caseId: string;
  node: unknown;
  wait: boolean;
  createdByUserId: number | null;
}) => {
  log('runPlaybookNode: case=%s node=%s', args.caseId, args.node);
  const row = await playbookCases.getByPublicId({
    projectIds: args.projectIds,
    id: args.caseId,
  });
  const definition = await caseDefinition({ row });
  const node = readCaseNode({ definition, node: args.node });
  await assertProjectAcceptsWork({ projectId: row.projectId });
  if (node.executor) {
    await resolveRunAs({ row, node: node.key, executors: [node.executor] });
  }

  const execution = await withLockedCase({
    row,
    work: async ({ locked, transaction }) => {
      assertCaseAcceptsWork({ locked, publicId: row.publicId });
      const view = (
        await caseNodeStates({
          caseDbId: row.id as number,
          definition,
          transaction,
        })
      ).views.get(node.key)!;
      assertRunnable({ node, view });
      // Recorded as claimed by this process, so the drain never runs it too.
      return db.PlaybookExecution.create(
        {
          caseId: row.id as number,
          node: node.key,
          playbookVersion: row.playbookVersion,
          executorType: node.executor?.type ?? null,
          executorId: node.executor?.id ?? null,
          status: 'running',
          leaseExpiresAt: new Date(Date.now() + EXECUTION_LEASE_MS),
          basis: view.basis,
          input: executorInput({
            executor: node.executor,
            values: view.values,
          }),
          createdByUserId: args.createdByUserId,
        },
        { transaction }
      );
    },
  });

  if (args.wait) {
    await executeClaimed({ executionId: execution.id as number });
  } else {
    void executeInBackground({ executionId: execution.id as number });
  }

  return getPlaybookCaseExecution({
    projectIds: args.projectIds,
    caseId: args.caseId,
    id: execution.publicId,
  });
};

export const listPlaybookCaseExecutions = async (args: {
  projectIds?: number[];
  caseId: string;
  node?: string;
  limit?: number;
  offset?: number;
}) => {
  log('listPlaybookCaseExecutions: case=%s', args.caseId);
  const row = await playbookCases.getByPublicId({
    projectIds: args.projectIds,
    id: args.caseId,
  });
  const where: Record<string, unknown> = { caseId: row.id as number };
  if (args.node !== undefined) where.node = args.node;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['id', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.PlaybookExecution.findAndCountAll({
        where,
        include: [{ model: db.User, as: 'createdBy' }],
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (execution) => {
      return mapPlaybookExecution({
        row: execution as ExecutionRow,
        casePublicId: row.publicId,
      });
    },
  });
};

/** The executor each completion event can settle. */
const EXECUTOR_OF_EVENT: Record<string, string> = {
  'tasks.closed': 'workflow',
  'orchestration_runs.succeeded': 'orchestration',
  'orchestration_runs.failed': 'orchestration',
};

const settleRunExecutions = async (event: SoatEvent): Promise<void> => {
  const pending = await db.PlaybookExecution.findAll({
    where: {
      executorType: EXECUTOR_OF_EVENT[event.type],
      runId: event.resourceId,
      status: 'running',
    },
  });
  for (const execution of pending) {
    await settleFromRun({ execution });
  }
};

/** Settles a node whose task closed or whose orchestration run ended. */
export const initializePlaybookExecutionListener = (): void => {
  onEvent({
    types: [
      'tasks.closed',
      'orchestration_runs.succeeded',
      'orchestration_runs.failed',
    ],
    handler: (event) => {
      retryOrRecordDrop({
        stage: 'playbook_execution_settle',
        label: 'settleRunExecutions',
        event,
        operation: () => {
          return settleRunExecutions(event);
        },
      });
    },
  });
};
