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
  indexes: [
    {
      name: 'orchestration_runs_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // Nested cost roll-ups walk descendants by parent, once per level.
    {
      name: 'orchestration_runs_parent_run_id_idx',
      fields: ['parent_run_id'],
    },
  ],
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

  // Stamped at start and never changed, so editing the orchestration cannot
  // re-shape a run already in flight (#872). Every execution entry point
  // resolves the graph through this rather than the live row. Null for runs
  // predating pinning, which fall back to the live row.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare orchestrationVersion: number | null;

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
      'queued',
      'running',
      'sleeping',
      'awaiting_input',
      'succeeded',
      'failed',
      'cancelled',
      'expired'
    ),
    allowNull: false,
    defaultValue: 'running',
  })
  declare status:
    | 'queued'
    | 'running'
    | 'sleeping'
    | 'awaiting_input'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'expired';

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

  // Set only on a child run spawned by a `loop` / `sub_orchestration` node. A
  // child meters its own usage, so the parent's cost roll-up needs this link
  // (#1135). Denormalized public ids, so the descendant walk needs no join and
  // survives a deleted parent.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare parentRunId: string | null;

  @Column({ type: DataType.STRING(128), allowNull: true })
  declare parentNodeId: string | null;

  // Denormalized (not an FK) so it survives trigger deletion and can be copied
  // onto the usage events of the run's generations for trigger attribution.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare triggerId: string | null;

  // A run outlives the request that created it, so it cannot borrow that
  // request's credential when a background worker drives it later — the
  // identity belongs to the run. Null for a path with no principal to name,
  // whose `soat` tool nodes then fail 401 rather than acting as nobody.
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare principalKind: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare principalId: string | null;

  // Set only while `sleeping`: the scheduler wakes runs whose `wakeAt` is due
  // and continues them from `wakeContext`.
  @Column({ type: DataType.DATE, allowNull: true })
  declare wakeAt: Date | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare wakeContext: object | null;

  // Crash recovery: refreshed each round while the driver makes progress, so a
  // driver that dies mid-execution leaves it to expire and the reaper re-drives
  // the run from its last checkpoint.
  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseExpiresAt: Date | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare input: object | null;

  // Forwarded as `X-Soat-Context-*` headers on the tool calls of every
  // generation the run spawns (#945). Persisted rather than threaded from the
  // request because the resume/wake/redrive paths carry no request body.
  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: null,
    field: 'tool_context',
  })
  declare toolContext: Record<string, string> | null;

  // Caller-owned labels (tenant, batch, ticket), round-tripped verbatim and
  // never read by the engine (#342). A column of its own rather than part of
  // `input`, whose `input_schema` may legitimately reject unknown keys.
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: null })
  declare metadata: Record<string, unknown> | null;

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
