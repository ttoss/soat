import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Actor } from './Actor';
import { AiProvider } from './AiProvider';
import { Discussion } from './Discussion';

@Table({
  tableName: 'discussion_participants',
  hooks: {
    beforeValidate: (instance: DiscussionParticipant) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.discussionParticipant
        );
      }
    },
  },
})
export class DiscussionParticipant extends Model {
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

  @Column({ type: DataType.STRING, allowNull: true })
  declare name: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare prompt: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare position: number;

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
    return AiProvider;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare aiProviderId: number | null;

  @BelongsTo(
    () => {
      return AiProvider;
    },
    { onDelete: 'SET NULL' }
  )
  declare aiProvider: AiProvider | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare model: string | null;

  @Column({ type: DataType.FLOAT, allowNull: true })
  declare temperature: number | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare effort: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
