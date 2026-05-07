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

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare agentId: string;

  @Index
  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare agentDbId: number | null;

  @BelongsTo(() => {
    return Agent;
  })
  declare agent: Agent | null;

  @ForeignKey(() => {
    return File;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare fileDbId: number | null;

  @BelongsTo(() => {
    return File;
  })
  declare file: File | null;

  // Denormalized for easy access without joining File
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare fileId: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare stepCount: number;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
