import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { DatasetItem } from './DatasetItem';
import { EvalRun } from './EvalRun';
import { Generation } from './Generation';

/**
 * One dataset item's outcome within one {@link EvalRun}.
 *
 * The row is **self-contained**: `input` and `expectedOutput` are frozen copies
 * taken at run time, so a later edit or delete of the dataset item cannot
 * rewrite what a finished run was scored against. `datasetItemId` is the link
 * back to the (still editable, still deletable) fixture, nulled when it goes.
 *
 * `output` is a copy of the generation's final text, and it is redacted
 * alongside the generation when that generation's content is purged — a purge
 * that left copies behind would not be a purge.
 */
@Table({
  tableName: 'eval_results',
  indexes: [
    {
      name: 'eval_results_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    { name: 'eval_results_eval_run_id_idx', fields: ['eval_run_id'] },
    // One result per item per run. Populated at insert time, so the later
    // `SET NULL` cannot collide (PostgreSQL unique indexes ignore NULLs), and
    // a redelivered item task in Phase 2 is a no-op rather than a duplicate.
    {
      name: 'eval_results_eval_run_id_dataset_item_id_unique',
      unique: true,
      fields: ['eval_run_id', 'dataset_item_id'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: EvalResult) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.evalResult);
      }
    },
  },
})
export class EvalResult extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return EvalRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare evalRunId: number;

  @BelongsTo(
    () => {
      return EvalRun;
    },
    { onDelete: 'CASCADE' }
  )
  declare evalRun: EvalRun;

  @ForeignKey(() => {
    return DatasetItem;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare datasetItemId: number | null;

  @BelongsTo(
    () => {
      return DatasetItem;
    },
    { onDelete: 'SET NULL' }
  )
  declare datasetItem: DatasetItem | null;

  /** Frozen copy of the item's `input` at run time. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare input: unknown;

  /** Frozen copy of the item's `expectedOutput` at run time. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare expectedOutput: string | null;

  /** Null when the generation itself failed before producing a record. */
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

  /** The agent's final output text. Redacted by a generation content purge. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare output: string | null;

  /** `[{ scorer, score, passed, reasoning? }]`, one entry per scorer. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare scores: unknown;

  /** AND over the per-scorer `passed` flags. */
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare passed: boolean;

  /** Item-level failure reason. Set instead of scoring, never alongside it. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare error: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
