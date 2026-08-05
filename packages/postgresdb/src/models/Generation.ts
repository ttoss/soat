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

  // Session the generation was produced for, when it was dispatched through one.
  // Together with `startedByActorId` this is the end-user attribution chain the
  // usage event copies at metering time, so spend can be rolled up per end user
  // and per conversation session. SET NULL on delete so removing a session never
  // blocks on (or rewrites) the generations it produced.
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

  // Usage attribution. These are read back at metering time (usageRecording.ts)
  // and copied onto the UsageEvent, which already carries them as its own
  // columns — this mirrors that shape. They live in typed columns rather than
  // the `metadata` bag because they are billing identity the platform enforces:
  // a caller must not be able to attribute spend to another action, trigger or
  // orchestration run. `orchestrationRunId` holds the run's *public* id and is
  // resolved to the internal FK at persist time.
  @Column({ type: DataType.STRING, allowNull: true })
  declare actionId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare triggerId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare orchestrationRunId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare nodeId: string | null;

  // The agent config version that served this generation
  // (docs/prd-agent-versions.md, Phase 2). Forging it would misattribute a
  // canary's behavior to the stable version in every downstream comparison.
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

  // Internal recovery state for a generation paused on a client tool: the full
  // message history, tool context and agent config needed by
  // agentGenerationRecovery.ts to resume after a restart. Never serialized to
  // any API response — it is not in the mapper at all, which is why it gets its
  // own column instead of an exclusion rule on `metadata`.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare pendingState: Record<string, unknown> | null;

  // Caller-owned annotation bag (F-15). The server writes nothing here, so
  // there is no reserved-key list to maintain and no key a caller can set that
  // reaches platform state.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, unknown> | null;

  // Content-purge marker. When set, the generation's content fields (`metadata`,
  // `error`, `extraction`, `pendingState`) have been cleared. The skeleton the
  // billing/audit ledger depends on survives: ids, timestamps, status, counters
  // and the usage-attribution columns above.
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
