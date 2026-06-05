import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { Actor } from './Actor';
import { Agent } from './Agent';
import { Conversation } from './Conversation';
import { Document } from './Document';

@Table({
  tableName: 'conversation_messages',
  indexes: [
    {
      unique: true,
      fields: ['conversation_id', 'document_id'],
    },
    {
      unique: true,
      fields: ['conversation_id', 'position'],
    },
    {
      unique: true,
      fields: ['conversation_id', 'idempotency_key'],
    },
  ],
})
export class ConversationMessage extends Model {
  @ForeignKey(() => {
    return Conversation;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare conversationId: number;

  @BelongsTo(
    () => {
      return Conversation;
    },
    { onDelete: 'CASCADE' }
  )
  declare conversation: Conversation;

  @ForeignKey(() => {
    return Document;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare documentId: number;

  @BelongsTo(() => {
    return Document;
  })
  declare document: Document;

  @Column({ type: DataType.STRING, allowNull: false })
  declare role: string;

  @ForeignKey(() => {
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare actorId: number | null;

  @BelongsTo(
    () => {
      return Actor;
    },
    { onDelete: 'SET NULL' }
  )
  declare actor: Actor | null;

  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'agent_id' })
  declare agentId: number | null;

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'SET NULL' }
  )
  declare agent: Agent | null;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare position: number;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, unknown> | null;

  @Column({ type: DataType.STRING, allowNull: true, field: 'idempotency_key' })
  declare idempotencyKey: string | null;
}
