import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Policy } from './Policy';
import { Project } from './Project';
import { User } from './User';

@Table({
  tableName: 'triggers',
  hooks: {
    beforeValidate: (instance: Trigger) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.trigger);
      }
    },
  },
})
export class Trigger extends Model {
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

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project;

  // The trigger creator. Firings execute as this identity; a deleted creator
  // keeps the trigger but makes firings fail closed.
  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare createdByUserId: number | null;

  @BelongsTo(
    () => {
      return User;
    },
    { onDelete: 'SET NULL' }
  )
  declare createdBy: User | null;

  @ForeignKey(() => {
    return Policy;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare policyId: number | null;

  @BelongsTo(
    () => {
      return Policy;
    },
    { onDelete: 'RESTRICT' }
  )
  declare policy: Policy | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  // manual | webhook | schedule — immutable after creation.
  @Column({ type: DataType.STRING, allowNull: false })
  declare type: string;

  // orchestration | agent | tool.
  @Column({ type: DataType.STRING, allowNull: false })
  declare targetType: string;

  // Public ID of the target resource in the same project.
  @Column({ type: DataType.STRING, allowNull: false })
  declare targetId: string;

  // Tool targets only — the action for soat/mcp tools.
  @Column({ type: DataType.STRING, allowNull: true })
  declare action: string | null;

  // Static input shallow-merged under fire-time input.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare input: Record<string, unknown> | null;

  // 5-field cron expression (UTC); present only for schedule triggers.
  @Column({ type: DataType.STRING, allowNull: true })
  declare cron: string | null;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  })
  declare active: boolean;

  // Webhook triggers only — HMAC signing secret.
  @Column({ type: DataType.STRING, allowNull: true })
  declare secret: string | null;

  // Schedule triggers only — server-computed next fire time (UTC).
  @Column({ type: DataType.DATE, allowNull: true })
  declare nextFireAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
