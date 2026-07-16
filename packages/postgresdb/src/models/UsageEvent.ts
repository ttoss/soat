import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Index,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Agent } from './Agent';
import { AiProvider } from './AiProvider';
import { Generation } from './Generation';
import { OrchestrationRun } from './OrchestrationRun';
import { Project } from './Project';
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
    { fields: ['project_id', 'created_at'] },
    { fields: ['run_id'] },
    { fields: ['trace_id'] },
    { fields: ['generation_id'] },
    { fields: ['meter_type'] },
    { unique: true, fields: ['idempotency_key'] },
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
    unique: true,
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
  @Index
  @ForeignKey(() => {
    return OrchestrationRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare runId: number | null;

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
  @Index
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

  @Column({ type: DataType.STRING, unique: true, allowNull: false })
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
