import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Dataset } from './Dataset';
import { Generation } from './Generation';

/**
 * One test case in a {@link Dataset}: the input messages an eval run replays
 * through the agent, plus the optional reference answer scorers compare
 * against.
 *
 * Items keep full CRUD. A run does not depend on them staying put — each
 * `EvalResult` freezes its own copy of `input` / `expectedOutput` — so editing
 * or deleting an item never rewrites the history of a run that already scored
 * it (the evaluations module doc — Frozen inputs).
 */
@Table({
  tableName: 'dataset_items',
  indexes: [
    {
      name: 'dataset_items_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    { name: 'dataset_items_dataset_id_idx', fields: ['dataset_id'] },
    {
      name: 'dataset_items_source_generation_id_idx',
      fields: ['source_generation_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: DatasetItem) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.datasetItem);
      }
    },
  },
})
export class DatasetItem extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Dataset;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare datasetId: number;

  @BelongsTo(
    () => {
      return Dataset;
    },
    { onDelete: 'CASCADE' }
  )
  declare dataset: Dataset;

  /** Array of `{ role, content }` messages, replayed verbatim into the agent. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare input: unknown;

  /** Reference answer for `exact_match` / `llm_judge`. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare expectedOutput: string | null;

  /** Free-form tags, e.g. `{"topic": "billing"}`. Opaque to the platform. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: object | null;

  /**
   * Set when the item was curated from real traffic (Phase 2). SET NULL rather
   * than CASCADE: the item is a deliberate fixture whose copy outlives the
   * generation it was taken from.
   */
  @ForeignKey(() => {
    return Generation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare sourceGenerationId: number | null;

  @BelongsTo(
    () => {
      return Generation;
    },
    { onDelete: 'SET NULL' }
  )
  declare sourceGeneration: Generation | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
