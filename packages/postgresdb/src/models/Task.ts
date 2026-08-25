import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';
import { TaskTransition } from './TaskTransition';
import { Workflow } from './Workflow';

/**
 * A Task is a durable *instance* bound to a workflow: current state, payload,
 * assignment, and a full transition history. Analogous to an OrchestrationRun,
 * except it does not terminate on its own and can revisit states — an entity
 * that lives, not a process that ends.
 */
@Table({
  tableName: 'tasks',
  indexes: [
    {
      name: 'tasks_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // Board queries: columns of a workflow filtered by state/status.
    {
      name: 'tasks_project_id_workflow_id_state_status_idx',
      fields: ['project_id', 'workflow_id', 'state', 'status'],
    },
    // Board queries and stall-episode reasoning by how long a task has parked.
    {
      name: 'tasks_project_id_status_entered_state_at_idx',
      fields: ['project_id', 'status', 'entered_state_at'],
    },
    // Stall sweeper (Phase 3): the precise due-set query. `stall_deadline_at` is
    // the precomputed `entered_state_at + stalled_after` for the current state
    // (null when the state defines no threshold or the stall was already
    // emitted this episode), so the sweeper selects only genuinely-due tasks.
    {
      name: 'tasks_status_stall_deadline_at_idx',
      fields: ['status', 'stall_deadline_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Task) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.task);
      }
    },
  },
})
export class Task extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project;

  @ForeignKey(() => {
    return Workflow;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare workflowId: number;

  // CASCADE (not RESTRICT): deleting a workflow removes its task instances too.
  // The open-task guard in `deleteWorkflow` still blocks deletion while any task
  // is open; once every task is closed (terminal), deleting the workflow also
  // removes those closed task rows (and their cascaded transition history),
  // matching the documented "only open tasks block deletion" semantics (#604).
  @BelongsTo(
    () => {
      return Workflow;
    },
    { onDelete: 'CASCADE' }
  )
  declare workflow: Workflow;

  // The workflow version this task lives in, stamped at creation and never
  // changed afterwards (#882). Every read of the state machine — the transition
  // validator, the approval gate, and payload validation — resolves through this
  // number rather than the live `Workflow` row, so editing a workflow cannot
  // re-shape a task already in flight, including one parked for weeks.
  //
  // A version *number* rather than a foreign key to `workflow_versions`: the
  // number is what the task response exposes and what an audit reader cites, it
  // matches `OrchestrationRun.orchestrationVersion` and `Generation.agentVersion`,
  // and the archive row is reachable from it with no join. Null only for tasks
  // created before pinning existed, which fall back to the live row — the
  // pre-#882 behavior, and the only thing there is to fall back to.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare workflowVersion: number | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  // Current state name.
  @Column({ type: DataType.STRING, allowNull: false })
  declare state: string;

  @Column({
    type: DataType.ENUM('open', 'closed'),
    allowNull: false,
    defaultValue: 'open',
  })
  declare status: 'open' | 'closed';

  // Mutable task data; input to guards and dispatch mappings. 100%
  // caller-owned — the engine never writes a key into it except the workflow
  // author's declared `payload_writes` (#846).
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare payload: Record<string, unknown>;

  // Server-owned: the result of the current state's last completed dispatch,
  // overwritten on every dispatch. Exposed to guards as `task.last_result` —
  // a namespace callers cannot write, unlike the payload bag (#846).
  @Column({ type: DataType.JSONB, allowNull: true })
  declare lastResult: unknown;

  // The caller context the *next* automation dispatch forwards as
  // `X-Soat-Context-*` headers on its tool calls (#950). Supplied per move — at
  // creation, and on each transition — and replaced wholesale by the move that
  // supplies one, so the credential a dispatch runs with belongs to whoever last
  // moved the task, matching the principal `resolveDispatchPrincipal` already
  // inherits.
  //
  // Deliberately **write-only**: unlike `OrchestrationRun.toolContext`, it is
  // absent from `mapTask` and therefore from every task read, webhook payload and
  // audit export. A run is short-lived and single-caller; a task is long-lived and
  // multi-actor, so a readable field here would park one principal's credential
  // where every other principal on the board can read it. Cleared when the task
  // reaches a terminal state, so a closed task holds no credential at rest.
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: null })
  declare toolContext: Record<string, string> | null;

  // Caller-owned key/value annotations supplied at creation, for attributing a
  // task to whatever the caller's own system knows about it — the tenant it
  // belongs to, the ticket that raised it, the import batch (#342).
  //
  // Distinct from `payload` on both sides: the engine may write into a payload
  // (a state's declared `payload_writes`) and every guard reads it, so a label
  // parked there is neither inert nor safe from the machine. Nothing in the
  // engine reads or writes this bag, and unlike `toolContext` it is readable —
  // a label is not a credential, so there is nothing here to leak to the other
  // principals on the board.
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: null })
  declare metadata: Record<string, unknown> | null;

  // Informational in v1: a user or actor public ID, not interpreted by the engine.
  @Column({ type: DataType.STRING, allowNull: true })
  declare assignee: string | null;

  // Provenance of the current state's automation: { kind, id, status }.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare activeDispatch: Record<string, unknown> | null;

  // running | completed | failed | unrouted for the current state's dispatch.
  @Column({ type: DataType.STRING, allowNull: true })
  declare automationStatus: string | null;

  // How many machine-driven transitions have run back-to-back with no outside
  // intervention (#885). A workflow state may dispatch work that transitions the
  // task straight back into that same state, and neither layer's validator sees
  // the cycle: orchestration cycle detection is intra-graph, and revisiting a
  // state is what workflows are *for*. This counter is the bound.
  //
  // It counts a *chain*, not a lifetime: any move by a person, a plain API key,
  // or an approval resolution resets it to 0, because an outside intervention is
  // exactly the evidence that the task is not spinning unattended. So a
  // long-lived task that legitimately revisits states for months is never
  // bounded by its own history — only by how far it can travel untouched.
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare automationChainDepth: number;

  // Basis for `stalled_after`; reset on every state entry.
  @Column({ type: DataType.DATE, allowNull: false })
  declare enteredStateAt: Date;

  // Phase 3 approval-gated transitions. While a transition declaring
  // `requires_approval` is parked awaiting an ApprovalItem, the task exposes the
  // pending transition name here; `pendingApprovalId` links the gating item so
  // resolution can clear exactly the gate it resolved. Both are cleared when the
  // task next transitions (approval approved) or the approval is rejected/expired.
  @Column({ type: DataType.STRING, allowNull: true })
  declare pendingTransition: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare pendingApprovalId: string | null;

  // Phase 3 stall sweeper. Precomputed `entered_state_at + stalled_after` for the
  // current state, or null when the state declares no `stalled_after` or the
  // stall was already emitted this episode. The sweeper claims a due row by
  // nulling this, so `tasks.stalled` fires exactly once per episode; the next
  // transition re-arms it.
  @Column({ type: DataType.DATE, allowNull: true })
  declare stallDeadlineAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;

  @HasMany(() => {
    return TaskTransition;
  })
  declare transitions: TaskTransition[];
}
