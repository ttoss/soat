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
  tableName: 'triggers',
  indexes: [
    {
      name: 'triggers_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
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

  // Public ids of the policies a firing acts under; queried by policy.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare policyIds: string[] | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  // manual | webhook | schedule | event — immutable after creation.
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
  @Column({ type: DataType.JSON, allowNull: true })
  declare input: Record<string, unknown> | null;

  /**
   * Caller context every firing forwards to the run it starts, so a tool
   * authorizing through `{{context:<key>}}` can be reached on a schedule — a
   * firing has no request to carry one.
   *
   * Write-only: accepted on write and never mapped onto a read, so the record
   * cannot be used to recover a value. A value may be a `{{secret:...}}`
   * reference, which keeps the credential in the secret store and leaves only
   * its name here.
   */
  @Column({ type: DataType.JSON, allowNull: true })
  declare toolContext: Record<string, string> | null;

  // 5-field cron expression (UTC); present only for schedule triggers.
  @Column({ type: DataType.STRING, allowNull: true })
  declare cron: string | null;

  // Event triggers only: type patterns ('*', 'prefix.*', or an exact name).
  @Column({ type: DataType.JSON, allowNull: true })
  declare events: string[] | null;

  // Event triggers only: SRN patterns; null matches any resource.
  @Column({ type: DataType.JSON, allowNull: true })
  declare eventResources: string[] | null;

  // Event triggers only: a structured filter over the event's `data`.
  @Column({ type: DataType.JSON, allowNull: true })
  declare eventData: Record<string, unknown> | null;

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
