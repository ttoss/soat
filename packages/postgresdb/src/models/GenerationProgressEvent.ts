import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { Generation } from './Generation';

/**
 * One fact about a generation's progress: a lifecycle change, a step starting
 * or ending, a tool call starting or ending, a sub-generation starting.
 *
 * Skeleton only. Every column is a type, an ordinal, an id, a status, a
 * duration or a timestamp; a tool's name, arguments and result, a step's text
 * and an error are content and live in the trace's step objects, so a purge or
 * zero retention never has to reach this table.
 *
 * `seq` is allocated per generation inside the insert's transaction, under a
 * lock on the generation, so rows commit in `seq` order.
 */
@Table({
  tableName: 'generation_progress_events',
  timestamps: true,
  updatedAt: false,
  indexes: [
    {
      name: 'generation_progress_events_generation_id_seq_unique',
      unique: true,
      fields: ['generation_id', 'seq'],
    },
  ],
})
export class GenerationProgressEvent extends Model {
  @ForeignKey(() => {
    return Generation;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare generationId: number;

  @BelongsTo(
    () => {
      return Generation;
    },
    { onDelete: 'CASCADE' }
  )
  declare generation: Generation;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare seq: number;

  @Column({ type: DataType.STRING(64), allowNull: false })
  declare type: string;

  // The step's index within the turn, across every segment of it.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare stepIndex: number | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare toolCallId: string | null;

  // How a tool call or a generation ended: `executed`, `failed`, `blocked`,
  // `tripwire` or `pending_approval` for a call; the settled status for a
  // generation.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare status: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare durationMs: number | null;

  // Public id of the generation a tool call started. Not a foreign key: the
  // child may live in a project the parent's reader cannot see.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare childGenerationId: string | null;

  declare createdAt: Date;
}
