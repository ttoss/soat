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
import { Actor } from './Actor';
import { Agent } from './Agent';
import { AiProvider } from './AiProvider';
import { Generation } from './Generation';
import { OrchestrationRun } from './OrchestrationRun';
import { Project } from './Project';
import { Session } from './Session';
import { Trace } from './Trace';
import { UsageComponent } from './UsageComponent';

/**
 * Append-only, billing-grade record of a single metered occurrence — one
 * completed LLM call, one compute execution, one request batch, one storage
 * snapshot. Attribution and idempotency live here once; the metered quantities
 * live in child {@link UsageComponent} rows (one per priced dimension), so no
 * meter type is privileged: `llm_tokens` is simply an event with several
 * components, and a new dimension is a new set of components, not a new column.
 * Rows are immutable — there is no `updatedAt` and no update/delete path — so
 * historical usage never changes after the fact.
 */
@Table({
  tableName: 'usage_events',
  timestamps: true,
  updatedAt: false,
  indexes: [
    {
      name: 'usage_events_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'usage_events_project_id_created_at_idx',
      fields: ['project_id', 'created_at'],
    },
    {
      name: 'usage_events_orchestration_run_id_idx',
      fields: ['orchestration_run_id'],
    },
    { name: 'usage_events_trace_id_idx', fields: ['trace_id'] },
    { name: 'usage_events_generation_id_idx', fields: ['generation_id'] },
    { name: 'usage_events_actor_id_idx', fields: ['actor_id'] },
    { name: 'usage_events_session_id_idx', fields: ['session_id'] },
    { name: 'usage_events_meter_type_idx', fields: ['meter_type'] },
    // A rollup that excludes verification spend filters on this; leaving it
    // unindexed would sequential-scan the largest table in the schema.
    { name: 'usage_events_source_idx', fields: ['source'] },
    { name: 'usage_events_ai_provider_id_idx', fields: ['ai_provider_id'] },
    {
      name: 'usage_events_idempotency_key_unique',
      unique: true,
      fields: ['idempotency_key'],
    },
  ],
  hooks: {
    beforeValidate: (instance: UsageEvent) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.usageEvent);
      }
    },
  },
})
export class UsageEvent extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project;

  // Orchestration run that initiated the occurrence, when it ran inside a run.
  // Null for standalone events.
  @ForeignKey(() => {
    return OrchestrationRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare orchestrationRunId: number | null;

  @BelongsTo(
    () => {
      return OrchestrationRun;
    },
    { onDelete: 'SET NULL' }
  )
  declare run: OrchestrationRun | null;

  // Node within the orchestration run, when applicable.
  @Column({ type: DataType.STRING, allowNull: true })
  declare nodeId: string | null;

  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare agentId: number | null;

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'SET NULL' }
  )
  declare agent: Agent | null;

  @ForeignKey(() => {
    return Generation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare generationId: number | null;

  @BelongsTo(
    () => {
      return Generation;
    },
    { onDelete: 'SET NULL' }
  )
  declare generation: Generation | null;

  // End-user attribution: the actor the metered occurrence was produced for and
  // the session it ran in, copied from the generation at write time (the same
  // freeze-at-write rule as `cost_usd`). Both null for work with no end user
  // behind it — orchestration runs, triggers, direct API generations. SET NULL
  // on delete so removing an actor or session never blocks on, or silently
  // rewrites, the historical spend attributed to it: the row survives with a
  // null dimension rather than disappearing from the project's totals.
  @ForeignKey(() => {
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare actorId: number | null;

  @BelongsTo(
    () => {
      return Actor;
    },
    { onDelete: 'SET NULL' }
  )
  declare actor: Actor | null;

  @ForeignKey(() => {
    return Session;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare sessionId: number | null;

  @BelongsTo(
    () => {
      return Session;
    },
    { onDelete: 'SET NULL' }
  )
  declare session: Session | null;

  // Trace the metered occurrence belongs to, for reconciliation against the
  // trace tree. SET NULL on delete so an old event never blocks trace removal.
  @ForeignKey(() => {
    return Trace;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare traceId: number | null;

  @BelongsTo(
    () => {
      return Trace;
    },
    { onDelete: 'SET NULL' }
  )
  declare trace: Trace | null;

  // The specific AI provider instance billed. Correlates the event to the
  // price book (a project may have several providers with the same slug).
  // SET NULL on delete so an old event never blocks provider removal; the
  // denormalized `provider`/`model` below preserve the as-billed receipt.
  @ForeignKey(() => {
    return AiProvider;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare aiProviderId: number | null;

  @BelongsTo(
    () => {
      return AiProvider;
    },
    { onDelete: 'SET NULL' }
  )
  declare aiProvider: AiProvider | null;

  // Public id of the trigger firing that initiated the occurrence (agent-target
  // triggers). A denormalized as-billed snapshot rather than an FK — it arrives
  // via generation metadata and must survive trigger deletion. Null otherwise.
  @Column({ type: DataType.STRING, allowNull: true })
  declare triggerId: string | null;

  // Caller-supplied logical action label passed through the generation's
  // metadata, so spend can roll up per action. Null when not labelled.
  @Column({ type: DataType.STRING, allowNull: true })
  declare actionId: string | null;

  // The workload that produced the spend. For a generation-backed event: `eval`
  // (an eval run's item generations) or null (ordinary agent traffic, already
  // identified by `generation_id` / `agent_id`). For a generation-less
  // completion it names the path — `chat`, `memory_extraction`,
  // `memory_consolidation`, `eval_judge` — the same label its idempotency key
  // carries. Verification spend is therefore `source IN ('eval','eval_judge')`
  // (the evaluations module doc).
  @Column({ type: DataType.STRING, allowNull: true })
  declare source: string | null;

  // Meter-type discriminator: `llm_tokens`, `compute_execution`, `api_request`,
  // `storage`. Selects which components an event carries.
  @Column({ type: DataType.STRING, allowNull: false })
  declare meterType: string;

  // Denormalized as-billed SKU: the vendor slug (`openai`, or `soat` for
  // platform meter types) and the billed unit — the model id for LLM calls,
  // the platform unit (e.g. `compute-second`) otherwise. Retained even if the AI
  // provider is later deleted so historical receipts stay accurate.
  @Column({ type: DataType.STRING, allowNull: false })
  declare provider: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare model: string;

  // Total cost in USD: the sum of the priced component costs, frozen at write
  // time. Null when no component was priced (usage captured, not yet priced) —
  // never "free".
  @Column({ type: DataType.DECIMAL, allowNull: true })
  declare costUsd: string | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare idempotencyKey: string;

  @HasMany(
    () => {
      return UsageComponent;
    },
    { onDelete: 'CASCADE' }
  )
  declare components: UsageComponent[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
