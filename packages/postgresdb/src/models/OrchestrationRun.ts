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
    // The descendant walk behind a nested cost roll-up reads children by parent,
    // once per level, so the lookup is indexed rather than a scan per run read.
    {
      name: 'orchestration_runs_parent_run_id',
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

  // The orchestration version this run executes, stamped at start and never
  // changed afterwards (#872). Every execution entry point — the first drive of
  // a queued run, a wake from `sleeping`, a human/approval resume, and a redrive
  // after a lease expiry — resolves the graph through this number rather than
  // reading the live `Orchestration` row, so editing the orchestration cannot
  // re-shape a run already in flight, including one parked for days.
  //
  // A version *number* rather than a foreign key to `orchestration_versions`:
  // the number is what the run response exposes and what an audit reader cites,
  // it matches `Generation.agentVersion`, and the archive row is reachable from
  // it with no join. Null only for runs created before pinning existed, which
  // fall back to the live row — the pre-#872 behavior, and the only thing there
  // is to fall back to.
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

  // The run that started this one, and the node within it — set only on a child
  // run a `loop` or `sub_orchestration` node spawned. A child is its own run
  // record with its own usage events, so without this link a parent's cost
  // roll-up silently excluded the work it ordered, and nothing on the wire could
  // even name the runs it started (#1135).
  //
  // Denormalized public ids rather than a self-referential foreign key, for the
  // same reason as `triggerId` below: the value is what the run response exposes
  // and what a descendant walk queries by, so it needs no join and survives a
  // parent row that is gone. Both null for a run a caller started directly.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare parentRunId: string | null;

  @Column({ type: DataType.STRING(128), allowNull: true })
  declare parentNodeId: string | null;

  // Public id of the trigger firing that started this run, when it was launched
  // by an agent-target/orchestration-target trigger. Denormalized (not an FK) so
  // it survives trigger deletion and can be propagated onto the usage events of
  // the run's in-run generations for correct in-run trigger attribution. Null
  // for runs started directly via the API.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare triggerId: string | null;

  // The principal that started this run, denormalized (not an FK) exactly like
  // `triggerId`. A run outlives the HTTP request that created it, so it cannot
  // borrow that request's credential when the background worker drives it
  // later: the identity has to belong to the run. `principalKind` is 'user' or
  // 'api_key' and `principalId` the matching public id (`user_…` / `key_…`) —
  // the same pair the REST layer stamps for attribution. Both null for runs
  // started by a path that has no principal to name, whose `soat` tool nodes
  // then fail with an explicit 401 rather than acting as nobody.
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare principalKind: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare principalId: string | null;

  // Durable background execution. When `status` is 'sleeping', the run is
  // parked on a scheduled wait (a `delay` timer or the interval between `poll`
  // attempts) and `wakeAt` holds when it should resume. The background
  // scheduler wakes runs whose `wakeAt` is due and continues them from
  // `wakeContext`, which describes the waiting node and how to continue it.
  // Both are null while a run is actively executing (`running`), waiting on a
  // human node (`awaiting_input`), or has reached a terminal state.
  @Column({ type: DataType.DATE, allowNull: true })
  declare wakeAt: Date | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare wakeContext: object | null;

  // Crash recovery. While a run is `running` it holds a lease: `leaseExpiresAt`
  // is set when execution starts and refreshed each round while the driver makes
  // progress. If the driver crashes or is redeployed mid-execution the lease is
  // never refreshed, so the background reaper reclaims runs whose lease has
  // expired and re-drives them from the last checkpoint. Null while a run is not
  // actively executing (`queued`/`sleeping`/`awaiting_input`/terminal).
  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseExpiresAt: Date | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare input: object | null;

  // The `tool_context` bag the caller supplied when starting the run, forwarded
  // as `X-Soat-Context-*` headers on the tool calls of every agent generation
  // the run spawns (#945). Persisted on the row rather than threaded from the
  // request for the same reason as `principalKind`/`principalId`: a run outlives
  // the request that started it, and the resume/wake/redrive paths carry no
  // request body a bag could travel in. Every drive re-reads it from here, so a
  // pause across `awaiting_input` or a background wake keeps the same context.
  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: null,
    field: 'tool_context',
  })
  declare toolContext: Record<string, string> | null;

  // Caller-owned key/value annotations supplied when the run was started, for
  // attributing a run to whatever the caller's own system calls a tenant, a
  // batch or a ticket (#342). Round-trips verbatim and is never read by the
  // engine: it is deliberately *not* merged into `state`, which is why it is a
  // column of its own rather than something a caller has to smuggle through
  // `input` — the run's business payload, which every node sees and an
  // `input_schema` may legitimately reject unknown keys from.
  //
  // Persisted on the row for the same reason as `toolContext`: a run outlives
  // the request that started it, so a background drive, a wake and a redrive
  // all read the label from here.
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
