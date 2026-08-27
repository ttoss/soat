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
  indexes: [
    {
      name: 'task_transitions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'task_transitions_task_id_created_at_idx',
      fields: ['task_id', 'created_at'],
    },
  ],
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

  // Named `principal*`, not `actor*`: these are never Actor public ids.
  @Column({ type: DataType.STRING, allowNull: false })
  declare principalKind: string;

  // Null for `automation`, whose cause is carried by `generationId` /
  // `orchestrationRunId` instead.
  @Column({ type: DataType.STRING, allowNull: true })
  declare principalId: string | null;

  // Dispatch that caused the move.
  @Column({ type: DataType.STRING, allowNull: true })
  declare generationId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare orchestrationRunId: string | null;

  // A `tool` dispatch produces no generation or run to point at, so the tool
  // itself records why the task moved — every automation move stays traceable.
  @Column({ type: DataType.STRING, allowNull: true })
  declare toolId: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare note: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
