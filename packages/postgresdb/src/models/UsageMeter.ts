import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Index,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Agent } from './Agent';
import { AiProvider } from './AiProvider';
import { Generation } from './Generation';
import { OrchestrationRun } from './OrchestrationRun';
import { PriceBook } from './PriceBook';
import { Project } from './Project';
import { Trace } from './Trace';

/**
 * Append-only, billing-grade record of a single LLM call's token usage. One
 * row is written per completed generation from the token counts the provider
 * reports. Rows are immutable — there is no `updatedAt` and no update/delete
 * path — so historical usage never changes after the fact.
 */
@Table({
  tableName: 'usage_meters',
  timestamps: true,
  updatedAt: false,
  indexes: [
    { fields: ['project_id', 'created_at'] },
    { fields: ['run_id'] },
    { unique: true, fields: ['idempotency_key'] },
  ],
  hooks: {
    beforeValidate: (instance: UsageMeter) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.usageMeter);
      }
    },
  },
})
export class UsageMeter extends Model {
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

  // Orchestration run that initiated the call, when the generation ran inside a
  // run. Null for standalone generations. Populated by orchestration metering.
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

  // Trace the metered call belongs to, for reconciliation against the trace
  // tree. SET NULL on delete so an old meter never blocks trace removal.
  @Index
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

  // The specific AI provider instance billed. Correlates the meter to the
  // price book (a project may have several providers with the same slug).
  // SET NULL on delete so an old meter never blocks provider removal; the
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

  // Public id of the trigger firing that initiated the generation (agent-target
  // triggers). A denormalized as-billed snapshot rather than an FK — it arrives
  // via generation metadata and must survive trigger deletion. Null when the
  // generation was not started by a trigger.
  @Column({ type: DataType.STRING, allowNull: true })
  declare triggerId: string | null;

  // Logical action being billed — the caller-supplied action label passed
  // through the generation's metadata. Lets spend roll up per action
  // independent of the agent/generation. Null when the caller did not label it.
  @Column({ type: DataType.STRING, allowNull: true })
  declare actionId: string | null;

  // Meter-type discriminator. `llm_tokens` (the default, today's rows) uses the
  // token columns below; other types (`node_execution`, `api_request`,
  // `storage`) use `quantity`/`unit` instead and leave the token columns at 0.
  // All existing rows backfill to `llm_tokens` via the default.
  @Column({
    type: DataType.STRING,
    allowNull: false,
    defaultValue: 'llm_tokens',
  })
  declare meterType: string;

  // Denormalized as-billed provider slug (e.g. `openai`), retained even if the
  // AI provider row is later deleted so historical receipts stay accurate. For
  // platform meter types this is `soat` and `model` names the billable SKU.
  @Column({ type: DataType.STRING, allowNull: false })
  declare provider: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare model: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare inputTokens: number;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare outputTokens: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare cachedTokens: number;

  // Reasoning tokens the provider reports separately (e.g. OpenAI
  // `completion_tokens_details.reasoning_tokens`). 0 when unreported.
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare reasoningTokens: number;

  // Generic measure for non-`llm_tokens` meter types (e.g. wall-clock seconds
  // for `node_execution`, request counts for `api_request`, GB-days for
  // `storage`). Null for `llm_tokens` rows, where the token columns above are
  // the source of truth — the same number is never double-encoded.
  @Column({ type: DataType.DECIMAL, allowNull: true })
  declare quantity: string | null;

  // Unit the `quantity` is measured in (e.g. `node_second`, `request`,
  // `gb_day`). Null for `llm_tokens` rows.
  @Column({ type: DataType.STRING, allowNull: true })
  declare unit: string | null;

  // Cost in USD computed at write time from the versioned price book. Null
  // until price-book pricing lands; a null cost means "tokens captured, not yet
  // priced" rather than "free".
  @Column({ type: DataType.DECIMAL, allowNull: true })
  declare costUsd: string | null;

  // The exact price-book row that produced `costUsd` — the "price-table
  // version" for an auditable receipt. Null when no price applied. SET NULL on
  // delete: `costUsd` is already frozen, so a removed price row never changes
  // the recorded cost, only the ability to trace which row explains it.
  @ForeignKey(() => {
    return PriceBook;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare priceId: number | null;

  @BelongsTo(
    () => {
      return PriceBook;
    },
    { onDelete: 'SET NULL' }
  )
  declare price: PriceBook | null;

  @Column({ type: DataType.STRING, unique: true, allowNull: false })
  declare idempotencyKey: string;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
