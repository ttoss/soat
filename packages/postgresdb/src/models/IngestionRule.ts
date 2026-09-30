import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { fillConverterPublicIds } from '../utils/converterPublicIds';
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
    },
    // `beforeSave`, not `beforeValidate`: only fields a save hook changes are
    // added to a partial `update`.
    beforeSave: async (instance: IngestionRule, options: object) => {
      await fillConverterPublicIds(instance, options);
      if (!instance.toolPublicId && !instance.agentPublicId) {
        throw new Error(
          'IngestionRule must reference either a tool or an agent'
        );
      }
    },
  },
  indexes: [
    {
      name: 'ingestion_rules_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'ingestion_rules_project_id_content_type_glob_unique',
      unique: true,
      fields: ['project_id', 'content_type_glob'],
    },
  ],
})
export class IngestionRule extends Model {
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
    { onDelete: 'SET NULL' }
  )
  declare tool: Tool | null;

  // Kept once the tool is deleted, so the rule still names its converter.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare toolPublicId: string | null;

  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare agentId: number | null;

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'SET NULL' }
  )
  declare agent: Agent | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare agentPublicId: string | null;

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
