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
    unique: true,
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

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
