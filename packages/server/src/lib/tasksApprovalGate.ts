import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import {
  type ApprovalResumeHandler,
  type DecisionOutput,
  emitApproval,
  type MappedApproval,
  registerApprovalResumeHandler,
} from './approvals';
import { emitTaskEvent } from './taskEvents';
import {
  findTaskInstance,
  mapTask,
  type TaskInstance,
  transitionTask,
} from './tasks';
import {
  findValidTransition,
  type WorkflowTransition,
} from './workflowsValidation';

const log = createDebug('soat:tasks');

// Long enough for a human queue, but bounded so a gate can never park a task
// forever. There is no per-transition override in the workflow schema yet.
const DEFAULT_APPROVAL_EXPIRES_IN_SECONDS = 24 * 60 * 60;

// The approved move can no longer be applied — its guard now rejects it, or a
// concurrent change invalidated it. Both are surfaced, never silently dropped.
const REJECTION_CODES: ReadonlySet<string> = new Set([
  'TASK_GUARD_REJECTED',
  'TASK_TRANSITION_CONFLICT',
]);

// Pre-checks a park against the loaded snapshot for a clear, fast error before
// the atomic claim. The claim itself is the authority under contention.
const assertParkable = (args: {
  task: TaskInstance;
  transition: WorkflowTransition;
  transitions: WorkflowTransition[];
}): void => {
  const { task, transition, transitions } = args;
  if (task.status === 'closed') {
    throw new DomainError(
      'TASK_TRANSITION_CONFLICT',
      `Task '${task.publicId}' is closed and can no longer transition.`
    );
  }
  if (task.pendingTransition) {
    throw new DomainError(
      'TASK_TRANSITION_CONFLICT',
      `Task '${task.publicId}' already has transition '${task.pendingTransition}' pending approval.`,
      { pendingTransition: task.pendingTransition }
    );
  }
  if (
    !findValidTransition({
      transitions,
      name: transition.name,
      fromState: task.state,
    })
  ) {
    throw new DomainError(
      'TASK_TRANSITION_CONFLICT',
      `Transition '${transition.name}' is not valid from state '${task.state}'.`,
      { transition: transition.name, fromState: task.state }
    );
  }
};

// Emits the gate's ApprovalItem, rolling the claim back on failure so the task
// is never left parked with no item behind the gate.
const emitGateApproval = async (args: {
  taskPublicId: string;
  projectId: number;
  transition: WorkflowTransition;
  note: string | null;
  /**
   * The `tool_context` the task held before the claim, restored alongside the
   * claim itself. The park is what stores the requester's bag (#950), so a park
   * that does not survive must not leave it behind for the next dispatch — which
   * would run a later, unrelated move's work with this requester's credential.
   */
  previousToolContext: Record<string, string> | null;
}): Promise<MappedApproval> => {
  const base = `Transition '${args.transition.name}' on task '${args.taskPublicId}' requires approval before it can move to '${args.transition.to}'.`;
  try {
    return await emitApproval({
      projectId: args.projectId,
      origin: 'task_transition',
      proposedAction: null,
      reasoning: args.note ? `${base} Requester note: ${args.note}` : base,
      expiresInSeconds: DEFAULT_APPROVAL_EXPIRES_IN_SECONDS,
      taskId: args.taskPublicId,
      taskTransition: args.transition.name,
    });
  } catch (error) {
    await db.Task.update(
      { pendingTransition: null, toolContext: args.previousToolContext },
      {
        where: {
          publicId: args.taskPublicId,
          pendingTransition: args.transition.name,
          pendingApprovalId: null,
        },
      }
    );
    throw error;
  }
};

/**
 * Parks a `requires_approval` transition instead of applying it: claims the
 * task's single approval gate atomically, emits a `task_transition` ApprovalItem
 * (the sole producer of this origin), and links the item back to the task. The
 * task keeps its current state and exposes `pending_transition` until the item
 * resolves. Guards are **not** evaluated here — they re-run when the approved
 * transition fires at resolution time, so a gate can be filed before the payload
 * that satisfies its guard is set.
 */
export const parkTransitionForApproval = async (args: {
  task: TaskInstance;
  transition: WorkflowTransition;
  /**
   * The transitions of the version the task is pinned to (#882), resolved by
   * the caller. Taking them as an argument rather than reading
   * `task.workflow.transitions` is what keeps the gate on the same machine the
   * transition was validated against a moment earlier.
   */
  transitions: WorkflowTransition[];
  note: string | null;
  /**
   * The sanitized `tool_context` this move supplied, or `undefined` to keep the
   * task's stored bag (#950). Written as part of the same guarded claim that
   * takes the gate, so the bag and the pending transition it belongs to are
   * never half-applied.
   */
  toolContext?: Record<string, string> | null;
}): Promise<ReturnType<typeof mapTask>> => {
  const { task, transition, transitions } = args;
  const taskPublicId = task.publicId;
  log(
    'parkTransitionForApproval: task=%s transition=%s',
    taskPublicId,
    transition.name
  );

  assertParkable({ task, transition, transitions });

  // Atomically claim the gate: at most one pending transition per task, and only
  // while it is still open and in the from-state we validated. A concurrent park
  // (or any transition) loses the guarded UPDATE and gets a conflict.
  const [claimed] = await db.Task.update(
    {
      pendingTransition: transition.name,
      ...(args.toolContext === undefined
        ? {}
        : { toolContext: args.toolContext }),
    },
    {
      where: {
        publicId: taskPublicId,
        status: 'open',
        state: task.state,
        pendingTransition: null,
      },
    }
  );
  if (claimed === 0) {
    throw new DomainError(
      'TASK_TRANSITION_CONFLICT',
      `Task '${taskPublicId}' could not be parked for approval — it moved, closed, or already has a pending transition.`
    );
  }

  const item = await emitGateApproval({
    taskPublicId,
    projectId: task.projectId as number,
    transition,
    note: args.note,
    previousToolContext: task.toolContext,
  });

  await db.Task.update(
    { pendingApprovalId: item.id },
    { where: { publicId: taskPublicId, pendingTransition: transition.name } }
  );
  log(
    'parkTransitionForApproval: parked task=%s approval=%s',
    taskPublicId,
    item.id
  );

  const refreshed = await findTaskInstance({ id: taskPublicId });
  return mapTask(refreshed!);
};

// Clears the gate for exactly the approval that resolved (guarded on
// `pendingApprovalId`), so a superseding gate is never clobbered and repeated
// resolution callbacks (sweep-vs-resolve) are idempotent.
const clearGate = async (args: {
  taskPublicId: string;
  approvalId: string;
}): Promise<void> => {
  await db.Task.update(
    { pendingTransition: null, pendingApprovalId: null },
    {
      where: {
        publicId: args.taskPublicId,
        pendingApprovalId: args.approvalId,
      },
    }
  );
};

// Appends the terminal (rejected/expired) outcome to the task's audited history.
// The task did not move, so from/to are the current state and `transition` is
// null — the row is a note, not a move.
const appendResolutionNote = async (args: {
  taskPublicId: string;
  decision: 'rejected' | 'expired';
  resolvedBy: string | null;
  reason: string | null;
}): Promise<void> => {
  const task = await db.Task.findOne({
    where: { publicId: args.taskPublicId },
  });
  if (!task) return;
  const note =
    args.decision === 'rejected'
      ? `Approval rejected${args.reason ? `: ${args.reason}` : ''}. Transition not applied.`
      : 'Approval expired before a decision; transition not applied.';
  await db.TaskTransition.create({
    taskId: task.id as number,
    fromState: task.state,
    toState: task.state,
    transition: null,
    principalKind: 'approval',
    principalId: args.resolvedBy,
    generationId: null,
    orchestrationRunId: null,
    note,
  });
};

// Guards re-run against the committed state, and a now-invalid move is
// surfaced rather than leaving the task parked against a resolved approval.
const applyApprovedTransition = async (args: {
  item: MappedApproval;
  decision: DecisionOutput;
}): Promise<void> => {
  const { item, decision } = args;
  if (!item.task_id || !item.task_transition) return;

  // Only fire while this item is still the task's active gate (a superseding
  // move or a competing resolution may have cleared it first).
  const task = await db.Task.findOne({ where: { publicId: item.task_id } });
  if (!task || task.pendingApprovalId !== item.id) return;

  try {
    await transitionTask({
      id: item.task_id,
      transition: item.task_transition,
      principal: { kind: 'approval', id: decision.resolvedBy },
      note: `Approved via approval ${item.id}.`,
    });
  } catch (error) {
    if (error instanceof DomainError && REJECTION_CODES.has(error.code)) {
      log(
        'applyApprovedTransition: transition=%s rejected (%s) task=%s',
        item.task_transition,
        error.code,
        item.task_id
      );
      await clearGate({ taskPublicId: item.task_id, approvalId: item.id });
      const refreshed = await findTaskInstance({ id: item.task_id });
      if (refreshed) {
        await emitTaskEvent({
          type: 'tasks.approval_failed',
          projectId: refreshed.projectId as number,
          task: mapTask(refreshed),
          extra: { transition: item.task_transition, errorCode: error.code },
        });
      }
      return;
    }
    throw error;
  }
};

/**
 * The task-transition producer's resumption callback (§1). Registered alongside
 * the orchestration `node` and tool-call handlers; each guards on `origin` so
 * only its own items are handled. On approval it fires the gated transition; on
 * rejection or expiry it clears the gate and records the outcome in history.
 */
export const resumeTaskTransitionApproval: ApprovalResumeHandler = async ({
  item,
  decision,
}) => {
  if (item.origin !== 'task_transition' || !item.task_id) return;

  if (decision.decision === 'approved') {
    await applyApprovedTransition({ item, decision });
    return;
  }

  await clearGate({ taskPublicId: item.task_id, approvalId: item.id });
  await appendResolutionNote({
    taskPublicId: item.task_id,
    decision: decision.decision,
    resolvedBy: decision.resolvedBy,
    reason: decision.reason,
  });
};

registerApprovalResumeHandler(resumeTaskTransitionApproval);
