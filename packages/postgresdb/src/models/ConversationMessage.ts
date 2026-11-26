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
      name: 'conversation_messages_conversation_id_document_id_unique',
      unique: true,
      fields: ['conversation_id', 'document_id'],
    },
    {
      name: 'conversation_messages_conversation_id_position_unique',
      unique: true,
      fields: ['conversation_id', 'position'],
    },
    {
      name: 'conversation_messages_conversation_id_idempotency_key_unique',
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

  @Column({ type: DataType.JSON, allowNull: true })
  declare metadata: Record<string, unknown> | null;

  /** Public ids of the files a user turn sends the model natively, in order. */
  @Column({ type: DataType.JSON, allowNull: true })
  declare fileIds: string[] | null;

  /**
   * The verified citations of the turn that produced an assistant message;
   * null on every message no citing turn produced.
   */
  @Column({ type: DataType.JSON, allowNull: true })
  declare citations: unknown[] | null;

  @Column({ type: DataType.STRING, allowNull: true, field: 'idempotency_key' })
  declare idempotencyKey: string | null;

  // The digest of the request the key names, so a key reused with a different
  // body is refused rather than replayed. Null on rows written without a key.
  @Column({
    type: DataType.STRING(64),
    allowNull: true,
    field: 'idempotency_digest',
  })
  declare idempotencyDigest: string | null;

  @Column({
    type: DataType.JSON,
    allowNull: true,
    field: 'response_messages',
  })
  declare responseMessages: unknown[] | null;

  // The `providerOptions` lifted off `responseMessages`, rejoined only when a
  // model call is built from them (server `lib/vendorOptions.ts`).
  @Column({ type: DataType.JSON, allowNull: true, field: 'vendor_options' })
  declare vendorOptions: unknown[] | null;

  // The provenance counts the message's content feeds a turn it is sent to:
  // the resolved block of a user message, or what an assistant message's turn
  // read beyond the messages it was sent (`generationProvenance.ts`).
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare untrustedToolResults: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare knowledgeResults: number;
}
