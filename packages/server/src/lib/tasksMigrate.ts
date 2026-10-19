import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { emitTaskEvent } from './taskEvents';
import {
  type ActiveDispatch,
  computeStallDeadline,
  findTaskInstance,
  mapTask,
  stateByName,
  type TaskInstance,
  type TaskPrincipal,
} from './tasks';
import {
  findArchivedDefinition,
  type WorkflowDefinition,
} from './taskWorkflowDefinition';
import { validatePayload, type WorkflowState } from './workflowsValidation';

const log = createDebug('soat:tasks');

/**
 * Moving an open task onto a newer version of its workflow.
 *
 * A task is pinned to the version it entered on, so the only way onto a newer
 * machine is this explicit request. Everything that would make the move
 * ambiguous is refused rather than guessed: a state the target lacks with no
 * `state_map` entry, a payload the target schema rejects, a dispatch in flight
 * (its `on_complete` routing belongs to the version it was dispatched under),
 * and a transition parked for approval. The mapped state's `on_enter` is not
 * fired: the caller transitions when it wants the target's automation.
 */

type MigrateArgs = {
  id: string;
  toVersion: number;
  stateMap?: Record<string, string>;
  principal: TaskPrincipal;
};

const migrationConflict = (args: {
  task: TaskInstance;
}): DomainError | null => {
  const { task } = args;
  if (task.status === 'closed') {
    return new DomainError(
      'TASK_MIGRATION_CONFLICT',
      `Task '${task.publicId}' is closed and stays on its workflow version.`
    );
  }
  if (task.pendingTransition) {
    return new DomainError(
      'TASK_MIGRATION_CONFLICT',
      `Task '${task.publicId}' has transition '${task.pendingTransition}' pending approval.`,
      { pending_transition: task.pendingTransition }
    );
  }
  const dispatch = task.activeDispatch as ActiveDispatch | null;
  if (task.automationStatus === 'running' || dispatch?.status === 'running') {
    return new DomainError(
      'TASK_MIGRATION_CONFLICT',
      `Task '${task.publicId}' has a dispatch in flight; migrate it once the dispatch settles.`
    );
  }
  return null;
};

// Closing belongs to a transition, which emits `tasks.closed` and scrubs the
// stored tool context; a migration that closed would do neither.
const assertOpenTarget = (target: WorkflowState): void => {
  if (target.terminal === true) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `State '${target.name}' is terminal; migrate to an open state and transition the task to close it.`,
      { state: target.name }
    );
  }
};

const mapTarget = (args: {
  states: WorkflowState[];
  name: string;
}): WorkflowState => {
  const target = stateByName(args);
  if (!target) {
    throw new DomainError(
      'TASK_STATE_NOT_FOUND',
      `The target version has no state named '${args.name}'.`,
      { state: args.name }
    );
  }
  return target;
};

/**
 * Every `state_map` target, checked once for a batch before any task moves:
 * a target the version lacks or a terminal one would refuse each task it
 * names, so it refuses the request instead.
 */
export const assertStateMapTargets = (args: {
  definition: WorkflowDefinition;
  stateMap?: Record<string, string>;
}): void => {
  for (const name of Object.values(args.stateMap ?? {})) {
    assertOpenTarget(mapTarget({ states: args.definition.states, name }));
  }
};

const resolveTargetState = (args: {
  task: TaskInstance;
  states: WorkflowState[];
  stateMap?: Record<string, string>;
}): WorkflowState => {
  const current = args.task.state;
  const mapped = args.stateMap?.[current];
  if (mapped === undefined) {
    const kept = stateByName({ states: args.states, name: current });
    if (!kept) {
      throw new DomainError(
        'TASK_MIGRATION_STATE_UNMAPPED',
        `The target version has no state '${current}'; map it in state_map.`,
        { state: current }
      );
    }
    return kept;
  }
  return mapTarget({ states: args.states, name: mapped });
};

const assertMigratable = (args: {
  task: TaskInstance;
  definition: WorkflowDefinition;
  stateMap?: Record<string, string>;
}): WorkflowState => {
  const conflict = migrationConflict({ task: args.task });
  if (conflict) throw conflict;
  const target = resolveTargetState({
    task: args.task,
    states: args.definition.states,
    stateMap: args.stateMap,
  });
  assertOpenTarget(target);
  validatePayload({
    payloadSchema: args.definition.payloadSchema,
    payload: (args.task.payload ?? {}) as Record<string, unknown>,
  });
  return target;
};

const assertNewerVersion = (args: {
  task: TaskInstance;
  toVersion: number;
}): void => {
  const pinned = args.task.workflowVersion;
  if (pinned != null && args.toVersion <= pinned) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Task '${args.task.publicId}' is on version ${pinned}; to_version must be newer.`,
      { to_version: args.toVersion, workflow_version: pinned }
    );
  }
};

export const loadVersionDefinition = async (args: {
  workflowDbId: number;
  version: number;
}): Promise<WorkflowDefinition> => {
  const definition = await findArchivedDefinition(args);
  if (!definition) {
    throw new DomainError(
      'WORKFLOW_VERSION_NOT_FOUND',
      `The workflow has no version ${args.version}.`,
      { version: args.version }
    );
  }
  return definition;
};

const loadTargetDefinition = async (args: {
  task: TaskInstance;
  toVersion: number;
}): Promise<WorkflowDefinition> => {
  assertNewerVersion(args);
  return loadVersionDefinition({
    workflowDbId: args.task.workflowId as number,
    version: args.toVersion,
  });
};

const performMigrationTxn = async (args: {
  migrateArgs: MigrateArgs;
  definition: WorkflowDefinition;
}): Promise<{ fromState: string; fromVersion: number | null }> => {
  const a = args.migrateArgs;
  return db.sequelize.transaction(async (t) => {
    const task = (await db.Task.findOne({
      where: { publicId: a.id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    })) as TaskInstance;

    // Re-checked under the lock: a concurrent migration may have moved it.
    assertNewerVersion({ task, toVersion: a.toVersion });
    const target = assertMigratable({
      task,
      definition: args.definition,
      stateMap: a.stateMap,
    });

    const fromState = task.state;
    const fromVersion = task.workflowVersion;
    task.workflowVersion = a.toVersion;
    if (target.name !== fromState) {
      task.state = target.name;
      task.enteredStateAt = new Date();
      // A settled dispatch's provenance belongs to the state being left.
      task.activeDispatch = null;
      task.automationStatus = null;
    }
    task.stallDeadlineAt = computeStallDeadline({
      state: target,
      enteredStateAt: task.enteredStateAt,
    });
    await task.save({ transaction: t });

    await db.TaskTransition.create(
      {
        taskId: task.id as number,
        fromState,
        toState: target.name,
        transition: null,
        principalType: a.principal.kind,
        principalId: a.principal.id,
        generationId: null,
        orchestrationRunId: null,
        note: null,
        fromWorkflowVersion: fromVersion,
        toWorkflowVersion: a.toVersion,
      },
      { transaction: t }
    );
    return { fromState, fromVersion };
  });
};

export const migrateTask = async (args: MigrateArgs) => {
  log(
    'migrateTask: id=%s toVersion=%d principal=%s',
    args.id,
    args.toVersion,
    args.principal.kind
  );

  const loaded = await findTaskInstance({ id: args.id });
  if (!loaded) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  const definition = await loadTargetDefinition({
    task: loaded,
    toVersion: args.toVersion,
  });

  const { fromState, fromVersion } = await performMigrationTxn({
    migrateArgs: args,
    definition,
  });

  const mapped = mapTask((await findTaskInstance({ id: args.id }))!);
  await emitTaskEvent({
    type: 'tasks.migrated',
    projectId: loaded.projectId as number,
    task: mapped,
    facts: { from_state: fromState, from_workflow_version: fromVersion },
  });
  return mapped;
};
