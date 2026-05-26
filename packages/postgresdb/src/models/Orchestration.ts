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
import { Project } from './Project';

@Table({
  tableName: 'orchestrations',
  hooks: {
    beforeValidate: (instance: Orchestration) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.orchestration);
      }
    },
  },
})
export class Orchestration extends Model {
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
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare nodes: object[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare edges: object[];

  @Column({ type: DataType.JSONB, allowNull: true })
  declare stateSchema: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare inputSchema: object | null;

  @HasMany(() => {
    return OrchestrationRun;
  })
  declare runs: OrchestrationRun[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}

// Import after class definition to avoid circular reference issues
import { OrchestrationRun } from './OrchestrationRun';
