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
    // Board queries: columns of a workflow filtered by state/status.
    { fields: ['project_id', 'workflow_id', 'state', 'status'] },
    // Board queries and stall-episode reasoning by how long a task has parked.
    { fields: ['project_id', 'status', 'entered_state_at'] },
    // Stall sweeper (Phase 3): the precise due-set query. `stall_deadline_at` is
    // the precomputed `entered_state_at + stalled_after` for the current state
    // (null when the state defines no threshold or the stall was already
    // emitted this episode), so the sweeper selects only genuinely-due tasks.
    { fields: ['status', 'stall_deadline_at'] },
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
    unique: true,
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

  // Mutable task data; input to guards and dispatch mappings.
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare payload: Record<string, unknown>;

  // Informational in v1 (user/actor public ID).
  @Column({ type: DataType.STRING, allowNull: true })
  declare assignee: string | null;

  // Provenance of the current state's automation: { kind, id, status }.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare activeDispatch: Record<string, unknown> | null;

  // running | completed | failed for the current state's dispatch.
  @Column({ type: DataType.STRING, allowNull: true })
  declare automationStatus: string | null;

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
