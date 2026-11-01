/**
 * A `loop` / `sub_orchestration` node whose child run parks (`awaiting_input`,
 * `sleeping`) parks its own run as `awaiting_input` with a `child_run`
 * `required_action` naming the children. The children's settle resumes it:
 * once every one named has settled, the node takes their outcome
 * (`nestedNodeArtifact`) and the parent drives on, or fails with the child's
 * error.
 *
 * Nothing else satisfies that node: `submit-human-input` refuses it, and an
 * operator `resume` re-checks the children instead of re-driving the node,
 * which would start them again.
 */
import createDebug from 'debug';

import { db } from '../db';
import { newLeaseExpiry } from './orchestrationLease';
import type { NestedRunResult } from './orchestrationNestedNodes';
import { isNestedRunSettled } from './orchestrationNestedRunOutcome';
import type { RequiredAction } from './orchestrationNodeTypes';
import { isRunPausedForDrive } from './orchestrationRunPause';
import type { MappedOrchestrationRun } from './orchestrations';

const log = createDebug('soat:orchestrations');

type RunRow = InstanceType<typeof db.OrchestrationRun>;

/** The children a run is parked on, as the node that parked it. */
export type ParkedChildRuns = { nodeId: string; runs: NestedRunResult[] };

export const isParkedOnChildRuns = (run: {
  status: string;
  requiredAction: object | null;
}): boolean => {
  const action = run.requiredAction as RequiredAction | null;
  return run.status === 'awaiting_input' && action?.type === 'child_run';
};

const readChildRunIds = (action: RequiredAction): string[] => {
  const ids = action.context.orchestration_run_ids;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => {
        return typeof id === 'string';
      })
    : [];
};

/**
 * The children `run` is parked on, in the order the node started them, when
 * every one has settled; `null` while any has not.
 */
const readSettledChildRuns = async (
  run: RunRow
): Promise<ParkedChildRuns | null> => {
  if (!isParkedOnChildRuns(run)) return null;
  const action = run.requiredAction as RequiredAction;
  const ids = readChildRunIds(action);
  const rows = await db.OrchestrationRun.findAll({
    where: { publicId: ids, parentRunId: run.publicId },
  });
  const byId = new Map(
    rows.map((row) => {
      return [row.publicId as string, row];
    })
  );
  const runs: NestedRunResult[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || !isNestedRunSettled(row.status)) return null;
    runs.push({
      id,
      status: row.status,
      output: row.output as Record<string, unknown> | null,
      error: row.error,
    });
  }
  return { nodeId: action.nodeId, runs };
};

/**
 * Resumes `run` from the node parked on its children once they have all
 * settled; `null` when it is not parked on children, one has not settled, an
 * operator pause holds it, or another settle claimed the resume first.
 */
export const resumeRunParkedOnChildren = async (args: {
  run: RunRow;
}): Promise<MappedOrchestrationRun | null> => {
  const { run } = args;
  const childRuns = await readSettledChildRuns(run);
  if (!childRuns) return null;
  if (await isRunPausedForDrive({ run })) return null;

  // Sibling children settling at once each see all settled; one claims. The
  // lease hands the run to the reaper if this drive dies.
  const [claimed] = await db.OrchestrationRun.update(
    { status: 'running', leaseExpiresAt: newLeaseExpiry() },
    { where: { id: run.id as number, status: 'awaiting_input' } }
  );
  if (claimed === 0) return null;
  await run.reload();
  log(
    'resumeRunParkedOnChildren: run=%s node=%s',
    run.publicId,
    childRuns.nodeId
  );

  const { resumeOrchestrationRunExecution } =
    await import('./orchestrationEngine');
  return resumeOrchestrationRunExecution({ run, childRuns });
};

/** Wakes the run a settled child was started by, if it is parked on it. */
export const wakeParentOfSettledRun = async (args: {
  run: { parentRunId: string | null; status: string };
}): Promise<void> => {
  const { run } = args;
  if (!run.parentRunId || !isNestedRunSettled(run.status)) return;
  const parent = await db.OrchestrationRun.findOne({
    where: { publicId: run.parentRunId },
  });
  if (parent) await resumeRunParkedOnChildren({ run: parent });
};

/**
 * What a run's settle wakes: a run parking on children checks them once itself,
 * since one can settle before the park lands; a settled child wakes its parent.
 */
export const wakeAfterSettle = async (args: {
  run: RunRow;
}): Promise<MappedOrchestrationRun | null> => {
  const { run } = args;
  if (run.status === 'awaiting_input') {
    return resumeRunParkedOnChildren({ run });
  }
  await wakeParentOfSettledRun({ run });
  return null;
};
