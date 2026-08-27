import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:orchestrations');

/**
 * The `node_executions` lifecycle of a paused node — a `human`,
 * `webhook (mode: "receive")`, or `approval` node that parks the run as
 * `awaiting_input`.
 *
 * A pause writes one `requires_action` record per attempt when it first parks
 * (see `summarizeNodeResult`). That record is then either **re-entered** (the
 * pause is re-executed without being satisfied) or **finalized** (the awaited
 * payload arrives). Both paths converge on the same row, so a finished run
 * never shows a paused node twice and never leaves it claiming it is still
 * waiting.
 */

/**
 * Reuses a paused node's existing `requires_action` row when its pause is
 * re-entered, so a pause stays one record per attempt. Returns whether a row
 * was reused (the caller writes a fresh one when not).
 *
 * A pause can be re-executed without being satisfied — `resume`, a reaper
 * redrive and a queue redelivery all re-drive the frontier, which is the parked
 * node. Pause nodes are pure and therefore unkeyed
 * (`SIDE_EFFECTING_NODE_TYPES`), so nothing else dedupes the replay and every
 * resume would append another row for `recordHumanInputResumption` to flip.
 *
 * `startedAt`/`completedAt` are preserved: re-entering a pause is not new work,
 * so it must not be metered again.
 */
export const reuseRequiresActionRow = async (args: {
  orchestrationRunId: number;
  nodeId: string;
  attempt: number;
  output: Record<string, unknown>;
}): Promise<boolean> => {
  const existing = await db.OrchestrationNodeExecution.findOne({
    where: {
      orchestrationRunId: args.orchestrationRunId,
      nodeId: args.nodeId,
      attempt: args.attempt,
      status: 'requires_action',
    },
  });
  if (!existing) return false;
  // Refresh the surfaced prompt/context — state may have advanced since the
  // first park — but leave the timestamps alone.
  await existing.update({ output: args.output, error: null });
  log(
    'reuseRequiresActionRow: reused pause record node=%s attempt=%d',
    args.nodeId,
    args.attempt
  );
  return true;
};

/**
 * Finalizes a human/webhook-receive node's own `node_executions` entry once
 * its pause is satisfied. Without this, that record is never revisited and the
 * finished run's history keeps claiming the node is still waiting on an action,
 * even though the submitted payload was already applied to `state`/`artifacts`
 * by `applyHumanInputToState`.
 */
export const recordHumanInputResumption = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  humanNodeId: string;
  humanOutput: Record<string, unknown>;
}): Promise<void> => {
  const { runRecord, humanNodeId, humanOutput } = args;
  await db.OrchestrationNodeExecution.update(
    { status: 'completed', output: humanOutput, completedAt: new Date() },
    {
      where: {
        orchestrationRunId: runRecord.id as number,
        nodeId: humanNodeId,
        status: 'requires_action',
      },
    }
  );
};
