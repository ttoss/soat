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
import { Orchestration } from './Orchestration';
import { OrchestrationCheckpoint } from './OrchestrationCheckpoint';
import { OrchestrationNodeExecution } from './OrchestrationNodeExecution';
import { Project } from './Project';

@Table({
  tableName: 'orchestration_runs',
  hooks: {
    beforeValidate: (instance: OrchestrationRun) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.orchestrationRun
        );
      }
    },
  },
})
export class OrchestrationRun extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Orchestration;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare orchestrationId: number;

  @BelongsTo(() => {
    return Orchestration;
  })
  declare orchestration: Orchestration;

  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project;

  @Column({
    type: DataType.ENUM(
      'running',
      'paused',
      'completed',
      'failed',
      'cancelled'
    ),
    allowNull: false,
    defaultValue: 'running',
  })
  declare status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare state: object;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare activeNodes: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare artifacts: object;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare requiredAction: object | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare traceId: string | null;

  // Durable background execution. When `status` is 'running' and `resumeAt` is
  // set, the run is waiting for a scheduled resumption (e.g. a `delay` timer or
  // the interval between `poll` attempts). The background scheduler picks up
  // runs whose `resumeAt` is due and resumes them from `resumeContext`, which
  // describes the waiting node and how to continue it. Both are null while a
  // run is actively executing or has reached a terminal/paused state.
  @Column({ type: DataType.DATE, allowNull: true })
  declare resumeAt: Date | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare resumeContext: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare input: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare output: object | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;

  @HasMany(() => {
    return OrchestrationCheckpoint;
  })
  declare checkpoints: OrchestrationCheckpoint[];

  @HasMany(() => {
    return OrchestrationNodeExecution;
  })
  declare nodeExecutions: OrchestrationNodeExecution[];
}
