import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { DatasetItem } from './DatasetItem';
import { EvalRun } from './EvalRun';

/**
 * One unit of work in the eval queue: run **this dataset item** of **this eval
 * run** (docs/prd-evaluations.md, Phase 2). An async run enqueues one task per
 * item at start; the eval worker claims them in batches, executes the item's
 * generation, writes its `EvalResult`, and acks by deleting the row. The run
 * finalizes when its last task is acked.
 *
 * Tasks are claimed with `SELECT … FOR UPDATE SKIP LOCKED`; the claimer sets
 * `leaseExpiresAt` and, if it fails to ack before the lease expires, the task
 * becomes claimable again — the at-least-once redelivery mechanism. Redelivery
 * is safe because writing a result is idempotent: `EvalResult` carries a unique
 * `(eval_run_id, dataset_item_id)` index, so a re-executed item upserts into
 * one row rather than double-counting.
 *
 * Why not the orchestration queue: `orchestration_run_tasks` carries a NOT NULL
 * FK to `orchestration_runs`, and its claim is a SQL join over
 * tasks → runs → projects that reads each project's `max_concurrent_runs`. An
 * eval item has no orchestration run to join through, so sharing that table
 * would mean nullable FKs on a shipped hot path plus a `ClaimedTask` shape that
 * no longer names what it points at. The mechanics that actually matter —
 * claim, lease, redelivery, batching — are shared through `createSweep` /
 * `createScheduler` instead, the same seam the other seven pollers use.
 */
@Table({
  tableName: 'eval_run_tasks',
  indexes: [
    {
      name: 'eval_run_tasks_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // One task per item per run: enqueueing a run's items is retry-safe, and a
    // duplicate enqueue cannot fan a single item out to two workers.
    {
      name: 'eval_run_tasks_eval_run_id_dataset_item_id_unique',
      unique: true,
      fields: ['eval_run_id', 'dataset_item_id'],
    },
    // The claim's due-set predicate: ordered by availability, filtered on the
    // lease.
    {
      name: 'eval_run_tasks_available_at_idx',
      fields: ['available_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: EvalRunTask) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.evalRunTask);
      }
    },
  },
})
export class EvalRunTask extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return EvalRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare evalRunId: number;

  @BelongsTo(
    () => {
      return EvalRun;
    },
    { onDelete: 'CASCADE' }
  )
  declare evalRun: EvalRun;

  /**
   * The item to execute. CASCADE: deleting the fixture mid-run removes its
   * pending task rather than leaving a task that can only ever fail — results
   * already written keep their frozen copies either way.
   */
  @ForeignKey(() => {
    return DatasetItem;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare datasetItemId: number;

  @BelongsTo(
    () => {
      return DatasetItem;
    },
    { onDelete: 'CASCADE' }
  )
  declare datasetItem: DatasetItem;

  /** Not claimable before this time — used for backoff after a failed attempt. */
  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare availableAt: Date;

  /** NULL until a worker claims the task. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare claimedAt: Date | null;

  /**
   * Redelivery deadline for the claiming worker. When it passes without an ack
   * (delete), the task is claimable again.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseExpiresAt: Date | null;

  /** Delivery attempts. Incremented on each claim. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attempts: number;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
