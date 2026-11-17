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

export const TASK_HISTORY_KINDS = [
  'transition',
  'migration',
  'dependency_added',
  'dependency_removed',
] as const;

export type TaskHistoryKind = (typeof TASK_HISTORY_KINDS)[number];

/**
 * Append-only history of a task's state changes. Every move — human, API,
 * automation outcome, approval resolution — writes exactly one row through
 * `transitionTask`, a version migration one through `migrateTask`, and adding or
 * removing a dependency one on each end, so the history is the audited contract
 * for a task.
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
    {
      name: 'task_transitions_task_id_idempotency_key_unique',
      unique: true,
      fields: ['task_id', 'idempotency_key'],
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

  // Null on a dependency row, which moves no state.
  @Column({ type: DataType.STRING, allowNull: true })
  declare toState: string | null;

  @Column({
    type: DataType.STRING(32),
    allowNull: false,
    defaultValue: 'transition',
  })
  declare kind: TaskHistoryKind;

  // The other end of the edge, on a dependency row only. A public id, so the
  // row outlives that task.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare relatedTaskId: string | null;

  // Transition name fired (null for the initial placement).
  @Column({ type: DataType.STRING, allowNull: true })
  declare transition: string | null;

  // Named `principal*`, not `actor*`: these are never Actor public ids.
  @Column({ type: DataType.STRING, allowNull: false })
  declare principalType: string;

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

  // Set only on a migration row, which moves the task between workflow
  // versions; a transition runs within one version and leaves both null.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare fromWorkflowVersion: number | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare toWorkflowVersion: number | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  // The caller's deduplication key, unique per task: a retried move replays
  // instead of applying twice.
  @Column({ type: DataType.STRING(255), allowNull: true })
  declare idempotencyKey: string | null;

  // Digest of the request the key names; a different request under it is
  // refused rather than replayed.
  @Column({ type: DataType.STRING(64), allowNull: true })
  declare idempotencyDigest: string | null;
}
