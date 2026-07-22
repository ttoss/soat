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
import { User } from './User';

/**
 * A failure or anomaly surfaced as a first-class, triageable item rather than a
 * log line. Auto-filed by the platform (exhausted node retries, guardrail
 * tripwires, expired approvals) or filed explicitly (`manual`) — never via a
 * public create endpoint. Repeated identical occurrences dedupe into one open
 * item with an incrementing `occurrenceCount` (Sentry-style aggregation), so a
 * hot failure loop never floods the queue while still preserving frequency.
 */
@Table({
  tableName: 'exception_items',
  indexes: [
    { fields: ['project_id', 'status', 'severity'] },
    // At most one OPEN exception per dedup key: repeated identical failures
    // fold into it (occurrenceCount++) instead of filing duplicates. A resolved
    // item leaves the key free, so a recurrence after resolution opens a fresh
    // exception. Manual items carry a null dedupKey and never dedupe (Postgres
    // treats nulls as distinct).
    {
      unique: true,
      fields: ['dedup_key'],
      where: { status: 'open' },
      name: 'exception_items_dedup_key_open_unique',
    },
  ],
  hooks: {
    beforeValidate: (instance: ExceptionItem) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.exception);
      }
    },
  },
})
export class ExceptionItem extends Model {
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

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project;

  // Triage lifecycle: open → acknowledged (someone is on it) → resolved (fixed).
  // Distinct from a boolean so "seen" and "fixed" are separate signals.
  @Column({
    type: DataType.ENUM('open', 'acknowledged', 'resolved'),
    allowNull: false,
    defaultValue: 'open',
  })
  declare status: 'open' | 'acknowledged' | 'resolved';

  @Column({
    type: DataType.ENUM('info', 'warning', 'critical'),
    allowNull: false,
    defaultValue: 'warning',
  })
  declare severity: 'info' | 'warning' | 'critical';

  @Column({
    type: DataType.ENUM(
      'run_failed',
      'guardrail_tripwire',
      'approval_expired',
      'manual'
    ),
    allowNull: false,
  })
  declare kind:
    'run_failed' | 'guardrail_tripwire' | 'approval_expired' | 'manual';

  @Column({ type: DataType.TEXT, allowNull: false })
  declare title: string;

  // Structured context (tool, args digest, error message, guardrail version …).
  @Column({ type: DataType.JSONB, allowNull: true })
  declare detail: object | null;

  // The identity repeated occurrences fold into while the item is open. Null for
  // `manual` items (never deduped).
  @Column({ type: DataType.STRING, allowNull: true })
  declare dedupKey: string | null;

  // How many times this exact failure has been observed while open. Starts at 1
  // and increments on each deduped recurrence; `lastSeenAt` tracks the latest.
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare occurrenceCount: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare lastSeenAt: Date;

  // ── Provenance (producer-dependent, held as public ids) ──────────────────
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare runId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare nodeId: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare agentId: string | null;

  // `${guardrailId}@${version}` when the item came from a guardrail tripwire.
  @Column({ type: DataType.STRING(64), allowNull: true })
  declare guardrailVersion: string | null;

  // ── Resolution ───────────────────────────────────────────────────────────
  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare acknowledgedByUserId: number | null;

  // Two associations target User (acknowledged/resolved), so each names its own
  // foreign key to stay unambiguous.
  @BelongsTo(() => {
    return User;
  }, 'acknowledgedByUserId')
  declare acknowledgedByUser: User | null;

  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare resolvedByUserId: number | null;

  @BelongsTo(() => {
    return User;
  }, 'resolvedByUserId')
  declare resolvedByUser: User | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare resolutionNote: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
