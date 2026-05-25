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
      fields: ['agent_db_id', 'status', 'started_at'],
    },
    {
      fields: ['trace_db_id'],
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

  // Intentionally denormalized for observability: retains the agent's public ID
  // even after the agent is deleted (agentDbId will be set to NULL by the DB).
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare agentId: string;

  @Index
  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare agentDbId: number | null;

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'SET NULL' }
  )
  declare agent: Agent | null;

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare traceId: string;

  @ForeignKey(() => {
    return Trace;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare traceDbId: number | null;

  @BelongsTo(() => {
    return Trace;
  })
  declare trace: Trace | null;

  // Self-referencing FK for generation chain (nested agent calls)
  @ForeignKey(() => {
    return Generation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare initiatorGenerationDbId: number | null;

  @BelongsTo(() => {
    return Generation;
  })
  declare initiatorGeneration: Generation | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare initiatorGenerationId: string | null;

  @ForeignKey(() => {
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare startedByActorDbId: number | null;

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
