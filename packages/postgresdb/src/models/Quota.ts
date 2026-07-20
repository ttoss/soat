import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';
import { QuotaWindowCounter } from './QuotaWindowCounter';

@Table({
  tableName: 'quotas',
  indexes: [
    { fields: ['project_id'] },
    { fields: ['project_id', 'scope', 'scope_ref', 'metric'] },
  ],
  hooks: {
    beforeValidate: (instance: Quota) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.quota);
      }
    },
  },
})
export class Quota extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project;

  /** `project` | `api_key` | `agent`. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare scope: string;

  /** Public id of the key/agent; NULL = all entities of that scope type. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare scopeRef: string | null;

  /** `requests` | `tokens` | `cost_usd`. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare metric: string;

  /** `rolling_1m` | `rolling_1h` | `rolling_24h` | `calendar_month`. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare window: string;

  @Column({ type: DataType.DECIMAL, allowNull: false })
  declare limit: string;

  /** `enforce` (block with 429) | `monitor` (no-op in Phase 1). */
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'enforce' })
  declare mode: string;

  /** Webhook fire state (once per window) — Phase 3. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare firedWindowKey: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastFiredAt: Date | null;

  @HasMany(() => {
    return QuotaWindowCounter;
  })
  declare counters: QuotaWindowCounter[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
