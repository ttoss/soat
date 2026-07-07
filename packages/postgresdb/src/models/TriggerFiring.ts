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
import { Trigger } from './Trigger';

@Table({
  tableName: 'trigger_firings',
  hooks: {
    beforeValidate: (instance: TriggerFiring) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.triggerFiring);
      }
    },
  },
})
export class TriggerFiring extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Trigger;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare triggerId: number;

  @BelongsTo(
    () => {
      return Trigger;
    },
    { onDelete: 'CASCADE' }
  )
  declare trigger: Trigger;

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

  // manual | webhook | schedule — how this firing started.
  @Column({ type: DataType.STRING, allowNull: false })
  declare source: string;

  // pending | running | succeeded | failed.
  @Column({ type: DataType.STRING, allowNull: false })
  declare status: string;

  // Effective (post-merge) input snapshot.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare input: Record<string, unknown> | null;

  // { target_type, result_id, status, output } — output truncated.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare result: Record<string, unknown> | null;

  // { code, message, meta }.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
