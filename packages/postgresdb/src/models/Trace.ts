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
import { Agent } from './Agent';
import { File } from './File';
import { Project } from './Project';

@Table({
  tableName: 'traces',
  indexes: [
    {
      fields: ['project_id', 'created_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Trace) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
      }
    },
  },
})
export class Trace extends Model {
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
    return File;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare fileId: number | null;

  @BelongsTo(
    () => {
      return File;
    },
    { onDelete: 'RESTRICT' }
  )
  declare file: File | null;

  @Index
  @ForeignKey(() => {
    return Trace;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare parentTraceId: number | null;

  @BelongsTo(
    () => {
      return Trace;
    },
    { foreignKey: 'parentTraceId', as: 'parentTrace', onDelete: 'RESTRICT' }
  )
  declare parentTrace: Trace | null;

  @Index
  @ForeignKey(() => {
    return Trace;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare rootTraceId: number | null;

  @BelongsTo(
    () => {
      return Trace;
    },
    { foreignKey: 'rootTraceId', as: 'rootTrace', onDelete: 'RESTRICT' }
  )
  declare rootTrace: Trace | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare stepCount: number;

  // Structured error payload recorded when a generation in this trace fails
  // (e.g. upstream AI provider errors).
  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: Record<string, unknown> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
