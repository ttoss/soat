import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';

@Table({
  tableName: 'model_routes',
  indexes: [
    {
      name: 'model_routes_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    { name: 'model_routes_project_id_idx', fields: ['project_id'] },
    {
      name: 'model_routes_project_id_name_unique',
      unique: true,
      fields: ['project_id', 'name'],
    },
  ],
  hooks: {
    beforeValidate: (instance: ModelRoute) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.modelRoute);
      }
    },
  },
})
export class ModelRoute extends Model {
  @Column({
    type: DataType.STRING(32),
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

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  /**
   * Ordered failover targets, stored in the wire (snake_case) shape:
   * `{ ai_provider_id, model, timeout_seconds?, max_retries? }`. The array is
   * copied as a value by the lib mapper — nothing walks its keys.
   */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare targets: object[];

  /** Subset of `provider_error` | `timeout` | `rate_limited`. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare retryOn: string[];

  /** Consecutive retryable failures before a target is skipped. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 3 })
  declare failureThreshold: number;

  /** How long a tripped target is skipped before being probed again. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 60 })
  declare cooldownSeconds: number;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
