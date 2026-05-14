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
  tableName: 'agent_formation_operations',
  hooks: {
    beforeValidate: (instance: AgentFormationOperation) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.agentFormationOperation
        );
      }
    },
  },
})
export class AgentFormationOperation extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return AgentFormation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare agentFormationId: number | null;

  @BelongsTo(() => {
    return AgentFormation;
  })
  declare agentFormation: AgentFormation | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare operationType: string;

  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'pending' })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare events: object[] | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare plan: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: object | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
