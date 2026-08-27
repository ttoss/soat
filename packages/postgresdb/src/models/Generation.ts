import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Actor } from './Actor';
import { Agent } from './Agent';
import { Project } from './Project';
import { Session } from './Session';
import { Trace } from './Trace';

@Table({
  tableName: 'generations',
  indexes: [
    {
      name: 'generations_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'generations_project_id_status_started_at_idx',
      fields: ['project_id', 'status', 'started_at'],
    },
    {
      name: 'generations_agent_id_status_started_at_idx',
      fields: ['agent_id', 'status', 'started_at'],
    },
    {
      name: 'generations_trace_id_idx',
      fields: ['trace_id'],
    },
    // Backs `list-generations` filtered by `orchestration_run_id`/`node_id`.
    {
      name: 'generations_orchestration_run_id_node_id_idx',
      fields: ['orchestration_run_id', 'node_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Generation) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.generation);
      }
    },
  },
})
export class Generation extends Model {
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

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project;

  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare agentId: number;

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'RESTRICT' }
  )
  declare agent: Agent;

  @ForeignKey(() => {
    return Trace;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare traceId: number;

  @BelongsTo(
    () => {
      return Trace;
    },
    { onDelete: 'RESTRICT' }
  )
  declare trace: Trace;

  // Self-referencing FK for generation chain (nested agent calls)
  @ForeignKey(() => {
    return Generation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare initiatorGenerationId: number | null;

  @BelongsTo(
    () => {
      return Generation;
    },
    { onDelete: 'RESTRICT' }
  )
  declare initiatorGeneration: Generation | null;

  @ForeignKey(() => {
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare startedByActorId: number | null;

  @BelongsTo(
    () => {
      return Actor;
    },
    { onDelete: 'SET NULL' }
  )
  declare startedByActor: Actor | null;

  // With `startedByActorId`, the end-user attribution chain the usage event
  // copies at metering time. SET NULL on delete so removing a session never
  // blocks on the generations it produced.
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

  // Denormalized principal info (set from JWT/API key context)
  @Column({ type: DataType.STRING, allowNull: true })
  declare startedByPrincipalType: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare startedByPrincipalId: string | null;

  @Column({
    type: DataType.STRING(32),
    allowNull: false,
    defaultValue: 'in_progress',
  })
  declare status: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare startedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastActivityAt: Date | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare stopReason: string | null;

  // Structured error payload recorded when the generation fails
  // (e.g. upstream AI provider errors).
  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: Record<string, unknown> | null;

  // Usage attribution, copied onto the UsageEvent at metering time. Typed
  // columns rather than the `metadata` bag because this is billing identity the
  // platform enforces — a caller must not be able to attribute spend to another
  // action, trigger or run. `orchestrationRunId` holds the run's *public* id.
  @Column({ type: DataType.STRING, allowNull: true })
  declare actionId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare triggerId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare orchestrationRunId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare nodeId: string | null;

  // Completes the replay identity the two columns above start: a retried node
  // produces one generation per attempt, otherwise distinguishable only by
  // guessing from timestamps.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare nodeAttempt: number | null;

  // `eval` for an eval run's items, null for production. Copied onto the
  // UsageEvent's `source` at metering time so verification spend is separable
  // from production spend. Typed, not `metadata`, for the same reason as above.
  @Column({ type: DataType.STRING, allowNull: true })
  declare source: string | null;

  // Forging this would misattribute a canary's behavior to the stable version
  // in every downstream comparison.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare agentVersion: number | null;

  // The model route's own record of which target served the generation and
  // every attempt it burned getting there. Written by modelRouteMetadata.ts.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare routing: Record<string, unknown> | null;

  // Memory-extraction summary written on completion (memoryExtraction.ts).
  // Derived from the generation's content, so a content purge clears it.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare extraction: Record<string, unknown> | null;

  // Recovery state for a generation paused on a client tool. Its own column
  // rather than an exclusion rule on `metadata`, so it cannot reach a response.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare pendingState: Record<string, unknown> | null;

  // Caller-owned. The server writes nothing here, so there is no reserved-key
  // list to maintain and no key a caller sets that reaches platform state.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, unknown> | null;

  // The resolved messages this turn answered, without the agent's instructions
  // or knowledge injections — those are config recoverable from `agentVersion`,
  // and replaying them as messages would double them up. Recorded so a real
  // turn can be promoted into an eval dataset item. Counts as content, so
  // zero-retention never writes it and a purge clears it.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare inputMessages: unknown[] | null;

  // Set once the content fields are cleared. The skeleton the billing/audit
  // ledger depends on survives.
  @Column({ type: DataType.DATE, allowNull: true })
  declare contentRedactedAt: Date | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare contentRedactedByPrincipalType: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare contentRedactedByPrincipalId: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
