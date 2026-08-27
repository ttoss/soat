import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { OrchestrationRun } from './OrchestrationRun';

/**
 * A unit of work in the orchestration queue (the Postgres driver): a run needs
 * driving now, or at `availableAt` — a fresh run (`continue`), a parked run
 * whose wait came due (`wake`), or external input to resume. Parking holds no
 * task; tasks exist only when a worker could pick up work.
 *
 * Claimed in batches with `SELECT … FOR UPDATE SKIP LOCKED`; the claimer sets
 * `leaseExpiresAt` and a task unacked past its lease becomes claimable again.
 * `attempts` counts deliveries and is deliberately **not** part of any node
 * idempotency key.
 */
@Table({
  tableName: 'orchestration_run_tasks',
  indexes: [
    {
      name: 'orchestration_run_tasks_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: OrchestrationRunTask) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.orchestrationRunTask
        );
      }
    },
  },
})
export class OrchestrationRunTask extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return OrchestrationRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare orchestrationRunId: number;

  @BelongsTo(() => {
    return OrchestrationRun;
  })
  declare run: OrchestrationRun;

  @Column({
    type: DataType.ENUM('continue', 'wake', 'resume'),
    allowNull: false,
  })
  declare kind: 'continue' | 'wake' | 'resume';

  // Not claimable before this time — used for backoff and scheduled availability.
  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare availableAt: Date;

  // NULL until a worker claims the task.
  @Column({ type: DataType.DATE, allowNull: true })
  declare claimedAt: Date | null;

  // Redelivery deadline for the claiming worker. When it passes without an
  // `ack` (delete), the task is claimable again.
  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseExpiresAt: Date | null;

  // Delivery attempts. Incremented on each claim. Never part of an idempotency
  // key — that keys on the node retry attempt (see OrchestrationNodeExecution).
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attempts: number;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
