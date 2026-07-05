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
  tableName: 'orchestration_node_executions',
})
export class OrchestrationNodeExecution extends Model {
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

  @Column({ type: DataType.STRING, allowNull: true })
  declare nodeType: string | null;

  // 1-based attempt number this execution record is for. A node with a retry
  // policy produces one record per attempt: failed attempts 1..N-1 followed by a
  // final `completed` (or a final `failed` when retries are exhausted).
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare attempt: number;

  @Column({
    type: DataType.ENUM('completed', 'failed', 'requires_action', 'skipped'),
    allowNull: false,
  })
  declare status: 'completed' | 'failed' | 'requires_action' | 'skipped';

  @Column({ type: DataType.JSONB, allowNull: true })
  declare input: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare output: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: object | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
