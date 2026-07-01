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
import { Project } from './Project';
import { Tool } from './Tool';

@Table({
  tableName: 'ingestion_rules',
  hooks: {
    beforeValidate: (instance: IngestionRule) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.ingestionRule);
      }
      if (instance.toolId && instance.agentId) {
        throw new Error(
          'IngestionRule cannot reference both a tool and an agent at the same time'
        );
      }
      if (!instance.toolId && !instance.agentId) {
        throw new Error(
          'IngestionRule must reference either a tool or an agent'
        );
      }
    },
  },
  indexes: [
    {
      unique: true,
      fields: ['project_id', 'content_type_glob'],
    },
  ],
})
export class IngestionRule extends Model {
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
  declare contentTypeGlob: string;

  @ForeignKey(() => {
    return Tool;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare toolId: number | null;

  @BelongsTo(
    () => {
      return Tool;
    },
    { onDelete: 'RESTRICT' }
  )
  declare tool: Tool | null;

  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare agentId: number | null;

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'RESTRICT' }
  )
  declare agent: Agent | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare action: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare presetParameters: object | null;

  @Column({
    type: DataType.STRING,
    allowNull: false,
    defaultValue: 'first',
  })
  declare nativeExtraction: string;

  @Column({
    type: DataType.STRING,
    allowNull: false,
    defaultValue: 'base64',
  })
  declare fileDelivery: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare chunkStrategy: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare chunkSize: number | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare chunkOverlap: number | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: object | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
