import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { onEvent, retryOrRecordDrop, type SoatEvent } from './eventBus';
import { paginatedList } from './pagination';
import {
  assertExecutorStartable,
  type PlaybookRunAs,
  resolvePlaybookRunAs,
} from './playbookAuthor';
import {
  caseDefinition,
  caseSnapshot,
  type PlaybookCaseRow,
  playbookCases,
} from './playbookCases';
import { conformsToInputSchema } from './playbookCaseState';
import type { JsonValue, PlaybookNode } from './playbookDefinition';
import { settleFromOutcome, settleFromRun } from './playbookExecutionSettle';
import { executorInput, startExecutor } from './playbookExecutors';
import { nodesByKey } from './playbookGraph';
import { playbookNodeStates, type PlaybookNodeView } from './playbookState';

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

const RUNNABLE_STATES: ReadonlySet<string> = new Set([
  'ready',
  'stale',
  'failed',
]);

/** A node runs when its inputs are set and its output is not current. */
const assertRunnable = (args: {
  node: PlaybookNode;
  view: PlaybookNodeView;
}): void => {
  const { node, view } = args;
  const blocked = view.missing.length > 0 || view.waiting.length > 0;
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
      waiting: view.waiting,
    }
  );
};

const readNode = (args: {
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

/** The case's author, checked against this node's executor before it runs. */
const resolveRunAs = async (args: {
  row: PlaybookCaseRow;
  node: PlaybookNode;
}): Promise<PlaybookRunAs | null> => {
  const { row, node } = args;
  if (!node.executor) return null;
  const version = await db.PlaybookVersion.findOne({
    where: { playbookId: row.playbookId, version: row.playbookVersion },
    attributes: ['principalKind', 'principalId'],
  });
  const runAs = await resolvePlaybookRunAs({
    version: version!,
    projectId: row.projectId,
    workPublicId: row.publicId,
  });
  await assertExecutorStartable({
    node: node.key,
    executor: node.executor,
    projectPublicId: row.project.publicId,
    isAllowed: runAs.isAllowed,
  });
  return runAs;
};

const execute = async (args: {
  row: PlaybookCaseRow;
  node: PlaybookNode;
  execution: ExecutionRow;
  values: Record<string, JsonValue>;
  runAs: PlaybookRunAs | null;
}): Promise<void> => {
  const { row, node, execution, values, runAs } = args;
  await settleFromOutcome({
    execution,
    outcome: async () => {
      if (!node.executor || !runAs) {
        return { kind: 'settled', output: values, runId: null };
      }
      return startExecutor({
        executor: node.executor,
        values,
        input: execution.input as Record<string, unknown>,
        projectId: row.projectId,
        executionPublicId: execution.publicId,
        title: `${row.subject} · ${node.title}`,
        runAs,
      });
    },
  });
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
const executeInBackground = async (
  args: Parameters<typeof execute>[0]
): Promise<void> => {
  try {
    await execute(args);
  } catch (error) {
    log(
      'executeInBackground: %s did not settle: %o',
      args.execution.publicId,
      error
    );
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
  const node = readNode({ definition, node: args.node });
  const runAs = await resolveRunAs({ row, node });

  const { execution, values } = await db.sequelize.transaction(
    async (transaction) => {
      // The case lock serializes this with input writes and settles, so the
      // state checked is the state the execution is recorded against.
      await db.PlaybookCase.findByPk(row.id as number, {
        lock: transaction.LOCK.UPDATE,
        transaction,
      });
      const view = playbookNodeStates({
        definition,
        snapshot: await caseSnapshot({
          caseDbId: row.id as number,
          transaction,
        }),
        conforms: conformsToInputSchema,
      }).get(node.key)!;
      assertRunnable({ node, view });
      const created = await db.PlaybookExecution.create(
        {
          caseId: row.id as number,
          node: node.key,
          playbookVersion: row.playbookVersion,
          executorType: node.executor?.type ?? null,
          executorId: node.executor?.id ?? null,
          status: 'running',
          basis: view.basis,
          input: executorInput({
            executor: node.executor,
            values: view.values,
          }),
          createdByUserId: args.createdByUserId,
        },
        { transaction }
      );
      return { execution: created, values: view.values };
    }
  );

  const work = { row, node, execution, values, runAs };
  if (args.wait) {
    await execute(work);
  } else {
    void executeInBackground(work);
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
