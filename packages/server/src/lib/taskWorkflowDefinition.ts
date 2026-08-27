import createDebug from 'debug';

import { db } from '../db';
import type { WorkflowState, WorkflowTransition } from './workflowsValidation';
import { workflowCollectionToCamel } from './workflowsWire';

const log = createDebug('soat:tasks');

/**
 * Resolves the state machine a task lives in (#882).
 *
 * A task is pinned to a workflow version at creation and every later read of
 * the definition resolves through here rather than the live `Workflow` row, so
 * `update-workflow` can rewire freely and a task parked for weeks still
 * transitions on the machine it entered on.
 *
 * The single seam matters as much as the pinning: before this, three call sites
 * each cast `workflow.transitions`, so missing one would look correct in review
 * and leave the bug in the path a long-lived task ends up in.
 */

export type WorkflowDefinition = {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  payloadSchema: unknown;
};

/** The pin, as it is stamped on a task row. */
type PinnedTask = {
  publicId: string;
  workflowVersion: number | null;
};

/** The live definition, as persisted on the workflow row (already camelCase). */
const liveDefinition = (
  workflow: InstanceType<typeof db.Workflow>
): WorkflowDefinition => {
  return {
    states: workflow.states as WorkflowState[],
    transitions: workflow.transitions as WorkflowTransition[],
    payloadSchema: workflow.payloadSchema,
  };
};

/**
 * The definition at one archived version of a workflow, or `null` when that
 * version was never archived.
 *
 * The archive stores the definition wire-shaped, so it comes back through the
 * same snake_case → camelCase boundary an inbound request uses.
 */
const findArchivedDefinition = async (args: {
  workflowDbId: number;
  version: number;
}): Promise<WorkflowDefinition | null> => {
  const archived = await db.WorkflowVersion.findOne({
    where: { workflowId: args.workflowDbId, version: args.version },
  });
  if (!archived) return null;

  const config = archived.config;
  /* istanbul ignore next -- the column is JSONB NOT NULL and only ever written
     from buildWorkflowConfigSnapshot, so no entry point can produce a non-object
     here; the narrowing exists to keep the return type honest. */
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return null;
  }

  const {
    states,
    transitions,
    payload_schema: payloadSchema,
  } = config as Record<string, unknown>;
  return {
    states: workflowCollectionToCamel<WorkflowState>(states) ?? [],
    transitions:
      workflowCollectionToCamel<WorkflowTransition>(transitions) ?? [],
    payloadSchema: payloadSchema ?? null,
  };
};

/**
 * The state machine a task must run on: its pinned version's, falling back to
 * the live row when there is no pinned version.
 *
 * The fallback covers one real case — a task created before pinning existed,
 * whose `workflowVersion` is null. The live row is the only machine those tasks
 * ever had, and refusing to transition them would strand every task open
 * across the deploy.
 *
 * A pinned version whose archive row is missing degrades the same way. It is
 * unreachable through the API, so this guards an out-of-band deletion rather
 * than a supported state; refusing instead would turn a bookkeeping
 * inconsistency into a permanently stuck task. The log line names either case.
 */
export const resolveTaskDefinition = async (args: {
  task: PinnedTask;
  /**
   * The task's workflow row. Passed in rather than read off the task because
   * every call site already loads it through the `workflow` include, and taking
   * it as a required argument is what keeps this module from silently resolving
   * an empty definition when an include is forgotten.
   */
  workflow: InstanceType<typeof db.Workflow>;
}): Promise<WorkflowDefinition> => {
  const { task, workflow } = args;
  const version = task.workflowVersion;

  if (version === null || version === undefined) {
    log(
      'resolveTaskDefinition: task=%s has no pinned version, using the live definition',
      task.publicId
    );
    return liveDefinition(workflow);
  }

  const archived = await findArchivedDefinition({
    workflowDbId: workflow.id as number,
    version,
  });

  if (!archived) {
    log(
      'resolveTaskDefinition: task=%s pinned to missing version=%d, using the live definition',
      task.publicId,
      version
    );
    return liveDefinition(workflow);
  }

  log(
    'resolveTaskDefinition: task=%s running version=%d',
    task.publicId,
    version
  );
  return archived;
};
