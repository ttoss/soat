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
import { Project } from './Project';

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

  // Denormalized as-billed provider slug (e.g. `openai`), retained even if the
  // AI provider row is later deleted so historical receipts stay accurate.
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

  // Cost in USD computed at write time from the versioned price book. Null
  // until price-book pricing lands; a null cost means "tokens captured, not yet
  // priced" rather than "free".
  @Column({ type: DataType.DECIMAL, allowNull: true })
  declare costUsd: string | null;

  @Column({ type: DataType.STRING, unique: true, allowNull: false })
  declare idempotencyKey: string;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
