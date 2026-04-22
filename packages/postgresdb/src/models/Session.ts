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
import { Agent } from './Agent';
import { Conversation } from './Conversation';
import { Project } from './Project';

@Table({
  tableName: 'sessions',
  hooks: {
    beforeValidate: (instance: Session) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.session);
      }
    },
  },
})
export class Session extends Model {
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

  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare agentId: number;

  @BelongsTo(() => {
    return Agent;
  })
  declare agent: Agent;

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
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'agent_actor_id' })
  declare agentActorId: number;

  @BelongsTo(
    () => {
      return Actor;
    },
    { foreignKey: 'agentActorId', as: 'agentActor' }
  )
  declare agentActor: Actor;

  @ForeignKey(() => {
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_actor_id' })
  declare userActorId: number;

  @BelongsTo(
    () => {
      return Actor;
    },
    { foreignKey: 'userActorId', as: 'userActor' }
  )
  declare userActor: Actor;

  @Column({ defaultValue: 'open' })
  declare status: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare name: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: {},
  })
  declare tags: Record<string, string> | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'generating_at' })
  declare generatingAt: Date | null;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'auto_generate',
  })
  declare autoGenerate: boolean;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
