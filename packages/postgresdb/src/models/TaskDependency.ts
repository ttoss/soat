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
 * `dependsOnTask` blocks `task` until it closes. The pair is the edge's
 * identity; `id` never leaves the server. Both ends cascade: deleting either
 * task removes the edge, which frees the dependent.
 */
@Table({
  tableName: 'task_dependencies',
  updatedAt: false,
  indexes: [
    {
      name: 'task_dependencies_edge_unique',
      unique: true,
      fields: ['task_id', 'depends_on_task_id'],
    },
    // The reverse lookup: what a task holds.
    {
      name: 'task_dependencies_depends_on_task_id_idx',
      fields: ['depends_on_task_id'],
    },
  ],
})
export class TaskDependency extends Model {
  @ForeignKey(() => {
    return Task;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare taskId: number;

  @BelongsTo(
    () => {
      return Task;
    },
    { foreignKey: 'taskId', onDelete: 'CASCADE' }
  )
  declare task: Task;

  @ForeignKey(() => {
    return Task;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare dependsOnTaskId: number;

  @BelongsTo(
    () => {
      return Task;
    },
    { foreignKey: 'dependsOnTaskId', onDelete: 'CASCADE' }
  )
  declare dependsOnTask: Task;

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
