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
import { Trigger } from './Trigger';

@Table({
  tableName: 'trigger_firings',
  indexes: [
    {
      name: 'trigger_firings_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // One firing per (event, trigger). NULLs do not collide in Postgres, so a
    // firing with no key — every source but `event` — is unconstrained.
    {
      name: 'trigger_firings_idempotency_key_unique',
      unique: true,
      fields: ['idempotency_key'],
    },
    // Drives the redelivery sweep's due query, the one statement that runs on
    // every scheduler tick for the lifetime of the process.
    {
      name: 'trigger_firings_status_lease_expires_at_idx',
      fields: ['status', 'lease_expires_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: TriggerFiring) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.triggerFiring);
      }
    },
  },
})
export class TriggerFiring extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Trigger;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare triggerId: number;

  @BelongsTo(
    () => {
      return Trigger;
    },
    { onDelete: 'CASCADE' }
  )
  declare trigger: Trigger;

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

  // manual | webhook | schedule | event — how this firing started.
  @Column({ type: DataType.STRING, allowNull: false })
  declare source: string;

  // pending | running | succeeded | failed.
  @Column({ type: DataType.STRING, allowNull: false })
  declare status: string;

  // Effective (post-merge) input snapshot.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare input: Record<string, unknown> | null;

  // { target_type, result_id, status, output } — output truncated.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare result: Record<string, unknown> | null;

  // { code, message, meta }.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: Record<string, unknown> | null;

  /**
   * `<event_id>:<trigger_public_id>` for an event firing, null for every other
   * source.
   *
   * It is what makes redelivery safe to attempt: the bus may hand the same
   * event to a restarted process, and the unique index turns the second
   * enqueue into a no-op rather than a second run of the target.
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare idempotencyKey: string | null;

  /**
   * The causation chain this firing dispatches under, including its own
   * trigger.
   *
   * Stored rather than carried: the chain travels in `AsyncLocalStorage`, which
   * a firing recovered by the sweep runs outside of. Without it a redelivered
   * firing would dispatch with an empty chain, and the loop guard that refused
   * the cycle in the first place would not refuse it again.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare causationChain: string[] | null;

  /** Dispatch attempts started. Bounds redelivery of a firing that kills its process. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attempts: number;

  /**
   * How long this firing is claimed for. Taken when the row is written, since
   * the writer attempts it immediately; the sweep reclaims a firing whose lease
   * has lapsed without a terminal status, which is exactly the firing whose
   * process died mid-dispatch.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseExpiresAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
