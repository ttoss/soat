import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Webhook } from './Webhook';

@Table({
  tableName: 'webhook_deliveries',
  indexes: [
    {
      name: 'webhook_deliveries_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // Drives the outbox sweep's due query, which is the one statement that runs
    // on every scheduler tick for the lifetime of the process.
    {
      name: 'webhook_deliveries_status_next_attempt_at_idx',
      fields: ['status', 'next_attempt_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: WebhookDelivery) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.webhookDelivery
        );
      }
    },
  },
})
export class WebhookDelivery extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Webhook;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare webhookId: number;

  @BelongsTo(
    () => {
      return Webhook;
    },
    { onDelete: 'CASCADE' }
  )
  declare webhook: Webhook;

  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare eventType: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
  })
  declare payload: object;

  @Column({
    type: DataType.ENUM('pending', 'success', 'failed'),
    allowNull: false,
    defaultValue: 'pending',
  })
  declare status: 'pending' | 'success' | 'failed';

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
  })
  declare statusCode: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
  })
  declare attempts: number;

  @Column({
    type: DataType.DATE,
    allowNull: true,
  })
  declare lastAttemptAt: Date | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
  })
  declare responseBody: string | null;

  /**
   * When this delivery becomes eligible for its next attempt. Set at insert
   * time (before the first HTTP call) and pushed out by the backoff after each
   * failure, so a `pending` row always carries its own due time rather than
   * depending on a retry loop living in some process's memory.
   *
   * Nullable only for rows written before the outbox existed; the sweep treats
   * `null` as "due now" so a deploy recovers deliveries a restart had stranded.
   */
  @Column({
    type: DataType.DATE,
    allowNull: true,
  })
  declare nextAttemptAt: Date | null;

  /**
   * Set while a process is attempting this delivery, and cleared when it
   * schedules the next attempt. A crash leaves the lease behind; the sweep
   * reclaims the row once it expires, which is what makes an interrupted
   * delivery resume instead of being stranded in `pending` forever.
   */
  @Column({
    type: DataType.DATE,
    allowNull: true,
  })
  declare leaseExpiresAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
