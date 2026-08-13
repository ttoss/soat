import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Eval } from './Eval';

/**
 * One execution of an {@link Eval} over its dataset.
 *
 * `agentVersion` is resolved **once**, at run start, and every item runs
 * against it. Without that pin, release assignment would bucket each item
 * independently (an eval generation has no session, so its assignment key is
 * null and each generation lands randomly), blending two configs into one score
 * — see the evaluations module doc, Version pinning.
 *
 * Never mutated after it reaches a terminal status, so there is no `updatedAt`;
 * `startedAt` / `finishedAt` carry the timeline.
 */
@Table({
  tableName: 'eval_runs',
  indexes: [
    {
      name: 'eval_runs_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'eval_runs_eval_id_created_at_idx',
      fields: ['eval_id', 'created_at'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: EvalRun) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.evalRun);
      }
    },
  },
})
export class EvalRun extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Eval;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare evalId: number;

  @BelongsTo(
    () => {
      return Eval;
    },
    { onDelete: 'CASCADE' }
  )
  declare eval: Eval;

  /** The one agent version every item in this run executed against. */
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare agentVersion: number;

  /** `queued` | `running` | `completed` | `failed` | `canceled`. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare status: string;

  /** A terminal run of the same Eval to compute deltas against (Phase 2). */
  @ForeignKey(() => {
    return EvalRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare baselineRunId: number | null;

  @BelongsTo(
    () => {
      return EvalRun;
    },
    { onDelete: 'SET NULL' }
  )
  declare baselineRun: EvalRun | null;

  /** Per-scorer mean and pass rate; null until the run is terminal. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare aggregateScores: object | null;

  /** Null when the Eval carries no `passThreshold`. */
  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare passed: boolean | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare itemCount: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare completedCount: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare erroredCount: number;

  /**
   * Public id of the trigger that started this run, when a trigger did
   * (the evaluations module doc — a nightly schedule pointed at an Eval).
   * Denormalized rather than an FK, exactly like `OrchestrationRun.triggerId`,
   * so the origin survives the trigger being deleted: a run is a historical
   * measurement and its provenance must not be rewritten by a later edit. Null
   * for runs started directly through the API.
   */
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare triggerId: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
