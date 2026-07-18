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
    // Stall sweeper (Phase 3): parked tasks past their threshold.
    { fields: ['project_id', 'status', 'entered_state_at'] },
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

  @BelongsTo(
    () => {
      return Workflow;
    },
    { onDelete: 'RESTRICT' }
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

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;

  @HasMany(() => {
    return TaskTransition;
  })
  declare transitions: TaskTransition[];
}
