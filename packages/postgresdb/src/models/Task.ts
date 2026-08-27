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
    // The stall sweeper's due-set query.
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

  // CASCADE (not RESTRICT): `deleteWorkflow` blocks while any task is open, so
  // the cascade only ever removes closed tasks — the documented "only open
  // tasks block deletion" semantics (#604).
  @BelongsTo(
    () => {
      return Workflow;
    },
    { onDelete: 'CASCADE' }
  )
  declare workflow: Workflow;

  // Stamped at creation and never changed, so editing a workflow cannot
  // re-shape a task already in flight (#882). Every read of the state machine
  // resolves through this rather than the live row. Null for tasks predating
  // pinning, which fall back to the live row.
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

  // Forwarded as `X-Soat-Context-*` headers on the next dispatch's tool calls
  // (#950), replaced wholesale by each move that supplies one.
  //
  // Deliberately **write-only** — absent from `mapTask`, so it never reaches a
  // task read, webhook payload or audit export. A task is long-lived and
  // multi-actor, so a readable field would park one principal's credential
  // where every other principal on the board can read it. Cleared on reaching
  // a terminal state.
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: null })
  declare toolContext: Record<string, string> | null;

  // Caller-owned labels (tenant, ticket, import batch), supplied at creation
  // (#342). Separate from `payload`, which the engine writes into and guards
  // read; nothing in the engine touches this. Readable, unlike `toolContext` —
  // a label is not a credential.
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

  // Bounds machine-driven transitions running back-to-back with no outside
  // intervention (#885) — a state can dispatch work that transitions straight
  // back into itself, and neither validator sees that cycle. Counts a chain,
  // not a lifetime: any human/API-key move or approval resolution resets it, so
  // a task that legitimately revisits states for months is never bounded by its
  // own history.
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare automationChainDepth: number;

  // Basis for `stalled_after`; reset on every state entry.
  @Column({ type: DataType.DATE, allowNull: false })
  declare enteredStateAt: Date;

  // While a `requires_approval` transition is parked, `pendingApprovalId` links
  // the gating item so resolution clears exactly the gate it resolved.
  @Column({ type: DataType.STRING, allowNull: true })
  declare pendingTransition: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare pendingApprovalId: string | null;

  // Precomputed `entered_state_at + stalled_after`. The sweeper claims a due
  // row by nulling this, so `tasks.stalled` fires exactly once per episode; the
  // next transition re-arms it.
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
