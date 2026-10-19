import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Workflow } from './Workflow';

/** One task of a run, in the order the run migrates them. */
export type WorkflowMigrationItem = {
  taskId: number;
  taskPublicId: string;
  status: 'pending' | 'migrated' | 'refused';
  error: { code: string; message: string; meta?: object } | null;
};

/**
 * A run moving a workflow's open tasks onto one of its versions. The tasks are
 * chosen when the run is recorded, so a task opened later is never swept in,
 * and each item settles once: a process that stops mid-run leaves the rest
 * `pending` for the next holder of the lease.
 */
@Table({
  tableName: 'workflow_migrations',
  indexes: [
    {
      name: 'workflow_migrations_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'workflow_migrations_workflow_id_idx',
      fields: ['workflow_id'],
    },
    {
      name: 'workflow_migrations_status_lease_expires_at_idx',
      fields: ['status', 'lease_expires_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: WorkflowMigration) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.workflowMigration
        );
      }
    },
  },
})
export class WorkflowMigration extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Workflow;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare workflowId: number;

  @BelongsTo(
    () => {
      return Workflow;
    },
    { onDelete: 'CASCADE' }
  )
  declare workflow: Workflow;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare toVersion: number;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare stateMap: Record<string, string> | null;

  @Column({ type: DataType.STRING(16), allowNull: false })
  declare status: 'queued' | 'running' | 'completed';

  @Column({ type: DataType.JSONB, allowNull: false })
  declare items: WorkflowMigrationItem[];

  @Column({ type: DataType.STRING(16), allowNull: true })
  declare createdByPrincipalType: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare createdByPrincipalId: string | null;

  /** Until when the process running it holds it; null once it settles. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseExpiresAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
