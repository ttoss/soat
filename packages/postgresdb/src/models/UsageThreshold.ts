import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Index,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';

/**
 * A per-project alert rule on windowed usage. When a project's `metric`
 * (`cost_usd` or `tokens`) over the configured `window` crosses `threshold`, a
 * `usage.threshold_crossed` webhook fires. The mutable fire state
 * (`lastFiredAt`, `firedWindowKey`) enforces the once-per-window /
 * hysteresis re-fire rules, which is why thresholds live in their own table
 * rather than a JSONB blob on the project. Thresholds are immutable apart from
 * deletion — replace by delete + create, which resets the fire state.
 */
@Table({
  tableName: 'usage_thresholds',
  timestamps: true,
  updatedAt: false,
  indexes: [{ fields: ['project_id'] }],
  hooks: {
    beforeValidate: (instance: UsageThreshold) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.usageThreshold);
      }
    },
  },
})
export class UsageThreshold extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @Index
  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project;

  // What is measured: `cost_usd` (across all meter types) or `tokens`
  // (input + output + cached).
  @Column({ type: DataType.STRING, allowNull: false })
  declare metric: string;

  // The evaluation window: `calendar_month` (current UTC month) or
  // `rolling_24h` (trailing 24 hours).
  @Column({ type: DataType.STRING, allowNull: false })
  declare window: string;

  // The value the windowed aggregate must cross to fire.
  @Column({ type: DataType.DECIMAL, allowNull: false })
  declare threshold: string;

  // Set to the moment the threshold last fired; null until first fire. For
  // `rolling_24h` a non-null value also marks the "fired" (disarmed) state,
  // cleared when the windowed value drops below 90% of the threshold.
  @Column({ type: DataType.DATE, allowNull: true })
  declare lastFiredAt: Date | null;

  // The `YYYY-MM` window key of the last fire, for `calendar_month`
  // once-per-window hysteresis; null for `rolling_24h` (and before first fire).
  @Column({ type: DataType.STRING, allowNull: true })
  declare firedWindowKey: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
