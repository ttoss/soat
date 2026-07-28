import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';

/**
 * One append-only entry per autonomously executed action, for "what did agents
 * do today" auditability. Distinct from `AuditEntry`: that table is
 * principal-centric (who authorized a request to the platform), while this one
 * is agent/run-centric (what an agent did during a run) — kinds here are never
 * permission-action strings. Security-relevant events (denies, guardrail
 * evaluations that changed an outcome) stay on `AuditEntry`; only autonomous
 * execution telemetry lands here.
 */
@Table({
  tableName: 'activity_entries',
  updatedAt: false,
  indexes: [
    {
      name: 'activity_entries_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'activity_entries_project_created_at',
      fields: ['project_id', 'created_at'],
    },
    // Tiebreaker for keyset pagination when two rows share a `created_at`.
    {
      name: 'activity_entries_project_created_public_id',
      fields: ['project_id', 'created_at', 'public_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: ActivityEntry) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.activityEntry);
      }
    },
  },
})
export class ActivityEntry extends Model {
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

  @Column({
    type: DataType.ENUM(
      'action_executed',
      'approval_resolved',
      'exception_created',
      'schedule_fired'
    ),
    allowNull: false,
  })
  declare kind:
    | 'action_executed'
    | 'approval_resolved'
    | 'exception_created'
    | 'schedule_fired';

  // Borrowed from ExceptionItem's severity vocabulary so the two
  // autonomous-action surfaces stay consistent; defaults are per-kind, applied
  // by the lib layer.
  @Column({
    type: DataType.ENUM('info', 'warning', 'critical'),
    allowNull: false,
    defaultValue: 'info',
  })
  declare severity: 'info' | 'warning' | 'critical';

  @Column({ type: DataType.TEXT, allowNull: false })
  declare summary: string;

  // Tool, args digest, policy version, or other kind-specific context.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare detail: object | null;

  // ── Provenance (producer-dependent, held as public ids — no FK) ──────────
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare runId: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare agentId: string | null;

  // Producer-specific reference (approval id, exception id, trigger firing id,
  // tool id — whichever the `kind` implies); intentionally untyped beyond
  // "some public id" so a new kind never needs a schema change.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare refId: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
