import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Agent } from './Agent';
import { Chat } from './Chat';
import { Project } from './Project';

@Table({
  tableName: 'actors',
  hooks: {
    beforeValidate: (instance: Actor) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.actor);
      }
      if (instance.agentId && instance.chatId) {
        throw new Error(
          'Actor cannot reference both an agent and a chat at the same time'
        );
      }
    },
  },
  indexes: [
    {
      unique: true,
      fields: ['project_id', 'external_id'],
    },
  ],
})
export class Actor extends Model {
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

  @Column({ type: DataType.STRING })
  declare type?: string;

  @Column({ type: DataType.STRING })
  declare externalId?: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare instructions: string | null;

  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare agentId: number | null;

  @BelongsTo(() => {
    return Agent;
  })
  declare agent: Agent | null;

  @ForeignKey(() => {
    return Chat;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare chatId: number | null;

  @BelongsTo(() => {
    return Chat;
  })
  declare chat: Chat | null;

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
