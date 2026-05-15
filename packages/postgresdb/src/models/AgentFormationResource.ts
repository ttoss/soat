import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { AgentFormation } from './AgentFormation';

@Table({
  tableName: 'agent_formation_resources',
  hooks: {
    beforeValidate: (instance: AgentFormationResource) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.agentFormationResource
        );
      }
    },
  },
  indexes: [{ unique: true, fields: ['agent_formation_id', 'logical_id'] }],
})
export class AgentFormationResource extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return AgentFormation;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare agentFormationId: number;

  @BelongsTo(() => {
    return AgentFormation;
  })
  declare agentFormation: AgentFormation;

  @Column({ type: DataType.STRING, allowNull: false })
  declare logicalId: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare resourceType: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare physicalResourceId: string | null;

  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'pending' })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare lastAppliedProperties: Record<string, unknown> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
