import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { OrchestrationRun } from './OrchestrationRun';
import { Project } from './Project';
import { User } from './User';

/**
 * A human-decision queue item. Created by the platform (an `approval`
 * orchestration node in Phase 1; tool-call interception in Phase 2) — never via
 * a public create endpoint. Freezes the proposed action and its supporting
 * evidence at emit time and enforces a server-side expiry gate.
 */
@Table({
  tableName: 'approval_items',
  indexes: [
    {
      name: 'approval_items_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'approval_items_project_id_status_expires_at_idx',
      fields: ['project_id', 'status', 'expires_at'],
    },
    // Makes "no duplicate proposal while one is pending" a DB-level guarantee.
    {
      unique: true,
      fields: ['dedup_key'],
      where: { status: 'pending' },
      name: 'approval_items_dedup_key_pending_unique',
    },
  ],
  hooks: {
    beforeValidate: (instance: ApprovalItem) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.approval);
      }
    },
  },
})
export class ApprovalItem extends Model {
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

  // How the item was produced. Analytics/filtering only — the lifecycle,
  // expiry, and decision shape never branch on this.
  @Column({
    type: DataType.ENUM('node', 'tool_call', 'task_transition'),
    allowNull: false,
    defaultValue: 'node',
  })
  declare origin: 'node' | 'tool_call' | 'task_transition';

  @Column({
    type: DataType.ENUM('pending', 'approved', 'rejected', 'expired'),
    allowNull: false,
    defaultValue: 'pending',
  })
  declare status: 'pending' | 'approved' | 'rejected' | 'expired';

  // Frozen at emit time, including the resolved `action`, so the platform can
  // execute the exact proposed call at resolution time. Null for a producer
  // whose proposal is not a tool call.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare proposedAction: {
    toolId: string;
    action?: string;
    arguments: object;
  } | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reasoning: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare evidence: object | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare predictedImpact: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  // Set on tool-call items (Phase 2): `(project_id, agent_id, tool_id,
  // args_digest)` while a matching item is pending.
  @Column({ type: DataType.STRING, allowNull: true })
  declare dedupKey: string | null;

  // An FK so resolution can re-enqueue the parked run; the mapper exposes its
  // publicId.
  @ForeignKey(() => {
    return OrchestrationRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare orchestrationRunId: number | null;

  @BelongsTo(() => {
    return OrchestrationRun;
  })
  declare orchestrationRun: OrchestrationRun | null;

  // The node id within the run's graph that emitted the item.
  @Column({ type: DataType.STRING, allowNull: true })
  declare nodeId: string | null;

  // The generation that emitted the item (tool-call producer, Phase 2).
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare generationId: string | null;

  // The session the emitting generation ran in, when any (tool-call producer).
  // Lets a tool-call continuation append to the originating session thread.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare sessionId: string | null;

  // Proposing agent's public id (informational).
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare agentId: string | null;

  // On `task_transition` items, the transition resolution re-fires through
  // `transitionTask` as the `approval` principal.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare taskId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare taskTransition: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare policyVersion: string | null;

  // The prior rejected item with this `dedup_key`, so approvers see the
  // recurrence. A soft link, like the other provenance ids.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare previousItemId: string | null;

  // ── Resolution ───────────────────────────────────────────────────────────
  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare resolvedByUserId: number | null;

  @BelongsTo(() => {
    return User;
  })
  declare resolvedByUser: User | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare resolutionReason: string | null;

  // Set on edit-then-approve; the original stays in `proposedAction`.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare editedArguments: object | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
