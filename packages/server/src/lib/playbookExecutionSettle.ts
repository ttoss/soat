import createDebug from 'debug';

import { db } from '../db';
import type { Transaction } from './dbTransaction';
import { mapRunWithIncludes } from './orchestrationRunHelpers';
import { advancePlaybookCase } from './playbookCascade';
import {
  appendEntries,
  caseDefinition,
  caseNodeStates,
  lockCase,
  playbookCases,
} from './playbookCases';
import type { JsonValue } from './playbookDefinition';
import { PARKED_RECHECK_MS } from './playbookExecutionLease';
import {
  type ExecutorOutcome,
  orchestrationOutcome,
} from './playbookExecutors';
import { type PlaybookBasis, samePlaybookBasis } from './playbookState';
import { stableDigest } from './stableDigest';
import {
  INTERNAL_FAILURE,
  type StoredError,
  toStoredError,
} from './storedError';
import { getTask } from './tasks';

const log = createDebug('soat:playbookExecutions');

type ExecutionRow = InstanceType<(typeof db)['PlaybookExecution']>;

/** How an execution ended: the executor's output, or why it has none. */
export type ExecutionSettlement =
  { output: JsonValue; runId: string | null } | { error: StoredError };

type CaseRow = InstanceType<(typeof db)['PlaybookCase']>;

/** The execution and its case, locked; null once it has settled. */
const lockRunning = async (args: {
  executionId: number;
  transaction: Transaction;
}): Promise<{ locked: CaseRow; execution: ExecutionRow } | null> => {
  const { transaction } = args;
  const unlocked = await db.PlaybookExecution.findByPk(args.executionId, {
    transaction,
  });
  // Deleting the case deletes its executions, so there is nothing to settle.
  if (!unlocked) return null;
  // Lock order matches every other case write: the case, then its rows.
  const locked = await lockCase({ caseDbId: unlocked.caseId, transaction });
  const execution = await db.PlaybookExecution.findByPk(args.executionId, {
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  return execution!.status === 'running'
    ? { locked: locked!, execution: execution! }
    : null;
};

/**
 * Whether the node still reads what the execution read, and the output it
 * holds now.
 */
const readNode = async (args: {
  locked: CaseRow;
  execution: ExecutionRow;
  transaction: Transaction;
}) => {
  const { execution } = args;
  const row = await playbookCases.reload(args.locked);
  const { snapshot, views } = await caseNodeStates({
    caseDbId: row.id as number,
    definition: await caseDefinition({ row }),
    transaction: args.transaction,
  });
  const view = views.get(execution.node)!;
  const current = samePlaybookBasis({
    left: execution.basis as PlaybookBasis,
    right: view.basis,
  });
  return {
    result: current ? 'current' : 'superseded',
    output: snapshot[execution.node]?.output,
  };
};

/** Appends the output entry; answers its revision. */
const writeOutput = async (args: {
  locked: CaseRow;
  execution: ExecutionRow;
  output: JsonValue;
  transaction: Transaction;
}): Promise<number> => {
  const { execution } = args;
  const [revision] = await appendEntries({
    locked: args.locked,
    transaction: args.transaction,
    entries: [
      {
        node: execution.node,
        kind: 'output',
        field: null,
        value: args.output,
        basis: execution.basis as PlaybookBasis,
        playbookVersion: execution.playbookVersion,
        createdBy: null,
      },
    ],
  });
  return revision;
};

/** The settle itself; answers the case it settled in, null when it did not. */
const settleOnce = async (args: {
  executionId: number;
  settlement: ExecutionSettlement;
}): Promise<number | null> => {
  const { settlement } = args;

  return db.sequelize.transaction(async (transaction) => {
    const running = await lockRunning({
      executionId: args.executionId,
      transaction,
    });
    if (!running) return null;
    const { locked, execution } = running;
    const { result, output } = await readNode({
      locked,
      execution,
      transaction,
    });
    const finishedAt = new Date();

    if ('error' in settlement) {
      log('settleExecution: %s failed', execution.publicId);
      await execution.update(
        { status: 'failed', result, error: settlement.error, finishedAt },
        { transaction }
      );
      return locked.id as number;
    }

    const changed =
      !output || stableDigest(output.value) !== stableDigest(settlement.output);
    const revision =
      result === 'current' && changed
        ? await writeOutput({
            locked,
            execution,
            output: settlement.output,
            transaction,
          })
        : null;

    log(
      'settleExecution: %s %s revision=%s',
      execution.publicId,
      result,
      revision
    );
    await execution.update(
      {
        status: 'succeeded',
        result,
        output: settlement.output,
        outputRevision: revision,
        runId: settlement.runId ?? execution.runId,
        finishedAt,
      },
      { transaction }
    );
    return locked.id as number;
  });
};

/**
 * Settles a running execution once, under the case's lock, then advances the
 * case. An execution whose inputs moved while it ran is kept as `superseded`
 * and writes nothing; one that returned the node's current value writes no
 * revision, which leaves every node reading it current.
 */
export const settleExecution = async (args: {
  executionId: number;
  settlement: ExecutionSettlement;
}): Promise<void> => {
  const caseDbId = await settleOnce(args);
  if (caseDbId !== null) await advancePlaybookCase({ caseDbId });
};

type PendingOutcome = Extract<ExecutorOutcome, { kind: 'pending' }>;

/** Settles from an outcome or the error it threw; answers it if pending. */
const settleUnlessPending = async (args: {
  execution: ExecutionRow;
  outcome: () => Promise<ExecutorOutcome>;
}): Promise<PendingOutcome | null> => {
  const executionId = args.execution.id as number;
  let outcome: ExecutorOutcome;
  try {
    outcome = await args.outcome();
  } catch (error) {
    await settleExecution({
      executionId,
      settlement: {
        error: toStoredError({
          error,
          opaque: INTERNAL_FAILURE,
          label: 'playbook execution',
        }),
      },
    });
    return null;
  }
  if (outcome.kind === 'pending') return outcome;
  await settleExecution({
    executionId,
    settlement: { output: outcome.output, runId: outcome.runId },
  });
  return null;
};

/** Where a pending execution's task or run has got to. */
const readRunOutcome = async (args: {
  executorType: string | null;
  runId: string;
}): Promise<ExecutorOutcome> => {
  const { runId } = args;
  if (args.executorType === 'workflow') {
    const task = await getTask({ id: runId });
    if (task.status !== 'closed') return { kind: 'pending', runId };
    return { kind: 'settled', output: task.payload as JsonValue, runId };
  }
  const run = await db.OrchestrationRun.findOne({
    where: { publicId: runId },
    attributes: ['id'],
  });
  return orchestrationOutcome(await mapRunWithIncludes(run!.id as number));
};

/** Settles a pending execution if its task or run has ended. */
export const settleFromRun = async (args: {
  execution: ExecutionRow;
}): Promise<void> => {
  const { execution } = args;
  await settleUnlessPending({
    execution,
    outcome: () => {
      return readRunOutcome({
        executorType: execution.executorType,
        runId: execution.runId as string,
      });
    },
  });
};

/** Settles an execution from what its executor came to. */
export const settleFromOutcome = async (args: {
  execution: ExecutionRow;
  outcome: () => Promise<ExecutorOutcome>;
}): Promise<void> => {
  const pending = await settleUnlessPending(args);
  if (!pending) return;

  // The run id is stored before the run is read back, so a completion event
  // arriving in between finds the execution, and one that arrived before it
  // is caught by the read.
  await args.execution.update({
    runId: pending.runId,
    leaseExpiresAt: new Date(Date.now() + PARKED_RECHECK_MS),
  });
  await settleFromRun({ execution: args.execution });
};
