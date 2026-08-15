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
  indexes: [
    {
      name: 'sessions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
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

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'CASCADE' }
  )
  declare agent: Agent;

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
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'actor_id' })
  declare actorId: number | null;

  @BelongsTo(
    () => {
      return Actor;
    },
    { foreignKey: 'actorId', as: 'actor', onDelete: 'SET NULL' }
  )
  declare actor: Actor | null;

  /**
   * The session this one was forked from, when it was created by
   * `POST /sessions/{id}/fork`.
   *
   * `ON DELETE SET NULL`: a fork is a real session with its own history, so
   * deleting the parent orphans the lineage pointer rather than taking the
   * fork with it.
   */
  @ForeignKey(() => {
    return Session;
  })
  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'forked_from_session_id',
  })
  declare forkedFromSessionId: number | null;

  @BelongsTo(
    () => {
      return Session;
    },
    {
      foreignKey: 'forkedFromSessionId',
      as: 'forkedFrom',
      onDelete: 'SET NULL',
    }
  )
  declare forkedFrom: Session | null;

  /** The parent conversation position the fork branched after. */
  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'forked_from_position',
  })
  declare forkedFromPosition: number | null;

  @Column({ type: DataType.STRING, defaultValue: 'open' })
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

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: null,
    field: 'tool_context',
  })
  declare toolContext: Record<string, string> | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'inactivity_ttl_seconds',
  })
  declare inactivityTtlSeconds: number;

  @Column({ type: DataType.DATE, allowNull: true, field: 'last_activity_at' })
  declare lastActivityAt: Date | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    defaultValue: null,
    field: 'message_delay_seconds',
  })
  declare messageDelaySeconds: number | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
