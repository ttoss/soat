import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';

@Table({
  tableName: 'tools',
  hooks: {
    beforeValidate: (instance: Tool) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.tool);
      }
    },
  },
})
export class Tool extends Model {
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

  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'http' })
  declare type: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare parameters: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare execute: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare mcp: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare actions: string[] | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare presetParameters: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare pipeline: object | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
