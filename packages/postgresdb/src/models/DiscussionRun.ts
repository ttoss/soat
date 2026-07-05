import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Conversation } from './Conversation';
import { Discussion } from './Discussion';
import { Document } from './Document';
import { Project } from './Project';

@Table({
  tableName: 'discussion_runs',
  hooks: {
    beforeValidate: (instance: DiscussionRun) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.discussionRun);
      }
    },
  },
})
export class DiscussionRun extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Discussion;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare discussionId: number;

  @BelongsTo(
    () => {
      return Discussion;
    },
    { onDelete: 'CASCADE' }
  )
  declare discussion: Discussion;

  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare topic: string;

  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'pending' })
  declare status: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare outcome: string | null;

  @ForeignKey(() => {
    return Conversation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare conversationId: number | null;

  @BelongsTo(
    () => {
      return Conversation;
    },
    { onDelete: 'SET NULL' }
  )
  declare conversation: Conversation | null;

  @ForeignKey(() => {
    return Document;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare outcomeDocumentId: number | null;

  @BelongsTo(
    () => {
      return Document;
    },
    { onDelete: 'SET NULL' }
  )
  declare outcomeDocument: Document | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare startedBy: Record<string, unknown> | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare initiatorGenerationId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare traceId: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
