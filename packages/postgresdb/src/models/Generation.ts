import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Index,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Actor } from './Actor';
import { Agent } from './Agent';
import { Project } from './Project';
import { Trace } from './Trace';

@Table({
  tableName: 'generations',
  indexes: [
    {
      fields: ['project_id', 'status', 'started_at'],
    },
    {
      fields: ['agent_id', 'status', 'started_at'],
    },
    {
      fields: ['trace_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Generation) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.generation);
      }
    },
  },
})
export class Generation extends Model {
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

  @Index
  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare agentId: number;

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'RESTRICT' }
  )
  declare agent: Agent;

  @ForeignKey(() => {
    return Trace;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare traceId: number;

  @BelongsTo(
    () => {
      return Trace;
    },
    { onDelete: 'RESTRICT' }
  )
  declare trace: Trace;

  // Self-referencing FK for generation chain (nested agent calls)
  @ForeignKey(() => {
    return Generation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare initiatorGenerationId: number | null;

  @BelongsTo(
    () => {
      return Generation;
    },
    { onDelete: 'RESTRICT' }
  )
  declare initiatorGeneration: Generation | null;

  @ForeignKey(() => {
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare startedByActorId: number | null;

  @BelongsTo(
    () => {
      return Actor;
    },
    { onDelete: 'SET NULL' }
  )
  declare startedByActor: Actor | null;

  // Denormalized principal info (set from JWT/API key context)
  @Column({ type: DataType.STRING, allowNull: true })
  declare startedByPrincipalType: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare startedByPrincipalId: string | null;

  @Column({
    type: DataType.STRING(32),
    allowNull: false,
    defaultValue: 'in_progress',
  })
  declare status: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare startedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastActivityAt: Date | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare stopReason: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, unknown> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
