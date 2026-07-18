import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Task } from './Task';

/**
 * Append-only history of a task's state changes. Every move — human, API,
 * automation outcome, approval resolution — writes exactly one row through
 * `transitionTask`, so the history is the audited contract for a task.
 */
@Table({
  tableName: 'task_transitions',
  updatedAt: false,
  indexes: [{ fields: ['task_id', 'created_at'] }],
  hooks: {
    beforeValidate: (instance: TaskTransition) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.taskTransition);
      }
    },
  },
})
export class TaskTransition extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Task;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare taskId: number;

  @BelongsTo(
    () => {
      return Task;
    },
    { onDelete: 'CASCADE' }
  )
  declare task: Task;

  // null on the initial placement.
  @Column({ type: DataType.STRING, allowNull: true })
  declare fromState: string | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare toState: string;

  // Transition name fired (null for the initial placement).
  @Column({ type: DataType.STRING, allowNull: true })
  declare transition: string | null;

  // user | api_key | automation | approval.
  @Column({ type: DataType.STRING, allowNull: false })
  declare actorKind: string;

  // Principal or automation provenance (public ID).
  @Column({ type: DataType.STRING, allowNull: true })
  declare actorId: string | null;

  // Dispatch that caused the move.
  @Column({ type: DataType.STRING, allowNull: true })
  declare generationId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare runId: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare note: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
