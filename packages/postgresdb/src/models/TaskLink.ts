import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { Task } from './Task';

/**
 * A typed relation from `fromTask` to `toTask` that never gates readiness.
 * `(from, to, kind)` is the link's identity; `id` never leaves the server.
 * Both ends cascade.
 */
@Table({
  tableName: 'task_links',
  updatedAt: false,
  indexes: [
    {
      name: 'task_links_edge_unique',
      unique: true,
      fields: ['from_task_id', 'to_task_id', 'kind'],
    },
    // The reverse lookup: what links to a task.
    { name: 'task_links_to_task_id_idx', fields: ['to_task_id', 'kind'] },
  ],
})
export class TaskLink extends Model {
  @ForeignKey(() => {
    return Task;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare fromTaskId: number;

  @BelongsTo(
    () => {
      return Task;
    },
    { foreignKey: 'fromTaskId', onDelete: 'CASCADE' }
  )
  declare fromTask: Task;

  @ForeignKey(() => {
    return Task;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare toTaskId: number;

  @BelongsTo(
    () => {
      return Task;
    },
    { foreignKey: 'toTaskId', onDelete: 'CASCADE' }
  )
  declare toTask: Task;

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare kind: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare note: string | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare createdByPrincipalType: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare createdByPrincipalId: string | null;

  /** Whom that principal acted for: an IAM token's or `On-Behalf-Of` principal. */
  @Column({ type: DataType.STRING(255), allowNull: true })
  declare createdByActsForType: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare createdByActsForId: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
