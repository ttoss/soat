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
 * `dependsOnTask` blocks `task` until it closes. Both ends cascade: deleting
 * either task removes the edge, which frees the dependent.
 */
@Table({
  tableName: 'task_dependencies',
  updatedAt: false,
  indexes: [
    {
      name: 'task_dependencies_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
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
  hooks: {
    beforeValidate: (instance: TaskDependency) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.taskDependency);
      }
    },
  },
})
export class TaskDependency extends Model {
  @Column({ type: DataType.STRING(32), allowNull: false })
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

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
