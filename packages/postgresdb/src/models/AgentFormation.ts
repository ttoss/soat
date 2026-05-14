import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { AgentFormationResource } from './AgentFormationResource';
import { Project } from './Project';

@Table({
  tableName: 'agent_formations',
  hooks: {
    beforeValidate: (instance: AgentFormation) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.agentFormation);
      }
    },
  },
  indexes: [{ unique: true, fields: ['project_id', 'name'] }],
})
export class AgentFormation extends Model {
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

  @HasMany(() => {
    return AgentFormationResource;
  })
  declare agentFormationResources: AgentFormationResource[];

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare template: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare outputs: Record<string, string> | null;

  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'creating' })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, unknown> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
