import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { Quota } from './Quota';

/**
 * Per-window fixed counters for the `requests` metric. One row per
 * `(quotaId, windowKey)` — the composite primary key is the atomic
 * upsert/increment target. Internal table: never exposed through the API, no
 * `publicId`. Token/cost windows have no counter table (they aggregate
 * `UsageMeter` at check time).
 */
@Table({
  tableName: 'quota_window_counters',
  timestamps: false,
})
export class QuotaWindowCounter extends Model {
  @ForeignKey(() => {
    return Quota;
  })
  @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true })
  declare quotaId: number;

  @BelongsTo(() => {
    return Quota;
  })
  declare quota: Quota;

  /** Truncated timestamp (`2026-07-07T12:31Z`) or `YYYY-MM`. */
  @Column({ type: DataType.STRING, allowNull: false, primaryKey: true })
  declare windowKey: string;

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare count: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
