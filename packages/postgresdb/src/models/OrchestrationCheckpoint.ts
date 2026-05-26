import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { OrchestrationRun } from './OrchestrationRun';

@Table({
  tableName: 'orchestration_checkpoints',
})
export class OrchestrationCheckpoint extends Model {
  @ForeignKey(() => {
    return OrchestrationRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare runId: number;

  @BelongsTo(() => {
    return OrchestrationRun;
  })
  declare run: OrchestrationRun;

  @Column({ type: DataType.STRING, allowNull: false })
  declare nodeId: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare state: object;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare artifacts: object;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
