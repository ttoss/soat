import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { AiProvider } from './AiProvider';
import { DiscussionParticipant } from './DiscussionParticipant';
import { Project } from './Project';

@Table({
  tableName: 'discussions',
  hooks: {
    beforeValidate: (instance: Discussion) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.discussion);
      }
    },
  },
})
export class Discussion extends Model {
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

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project;

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare maxRounds: number;

  @ForeignKey(() => {
    return AiProvider;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare aiProviderId: number;

  @BelongsTo(() => {
    return AiProvider;
  })
  declare aiProvider: AiProvider;

  @Column({ type: DataType.STRING, allowNull: true })
  declare model: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare synthesis: Record<string, unknown> | null;

  @HasMany(() => {
    return DiscussionParticipant;
  })
  declare participants: DiscussionParticipant[];

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: {},
  })
  declare tags: Record<string, string> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
