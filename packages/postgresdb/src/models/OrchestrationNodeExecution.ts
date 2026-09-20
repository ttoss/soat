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
  indexes: [
    {
      name: 'orchestration_node_executions_idempotency_key_unique',
      unique: true,
      fields: ['idempotency_key'],
    },
  ],
})
export class OrchestrationNodeExecution extends Model {
  @ForeignKey(() => {
    return OrchestrationRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare orchestrationRunId: number;

  @BelongsTo(() => {
    return OrchestrationRun;
  })
  declare run: OrchestrationRun;

  @Column({ type: DataType.STRING, allowNull: false })
  declare nodeId: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare nodeType: string | null;

  // A node with a retry policy produces one record per attempt.
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare attempt: number;

  // Every dispatch of this attempt, including the first. A redelivered task
  // that takes over a `running` row re-runs the node's side effect under the
  // same key and the same `attempt`, so a count above 1 is work the run issued
  // — and paid for — more than once.
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare dispatches: number;

  // `{run}:{node}:{attempt}`, where `attempt` is the node retry attempt, NOT
  // the queue delivery counter. Written `running` before a side-effecting node
  // dispatches, so a redelivered task finding a `completed` row reuses its
  // stored `output` instead of re-executing. NULL for pure nodes, which have no
  // side effect to guard.
  @Column({ type: DataType.STRING, allowNull: true })
  declare idempotencyKey: string | null;

  @Column({
    type: DataType.ENUM(
      'running',
      'completed',
      'failed',
      'requires_action',
      'skipped'
    ),
    allowNull: false,
  })
  declare status:
    'running' | 'completed' | 'failed' | 'requires_action' | 'skipped';

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
