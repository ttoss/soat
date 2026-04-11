import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { Actor } from './Actor';
import { Conversation } from './Conversation';
import { Document } from './Document';

@Table({
  tableName: 'conversation_messages',
  indexes: [
    {
      unique: true,
      fields: ['conversation_id', 'document_id'],
    },
  ],
})
export class ConversationMessage extends Model {
  @ForeignKey(() => {
    return Conversation;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare conversationId: number;

  @BelongsTo(() => {
    return Conversation;
  })
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

  @ForeignKey(() => {
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare actorId: number;

  @BelongsTo(() => {
    return Actor;
  })
  declare actor: Actor;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare position: number;
}
