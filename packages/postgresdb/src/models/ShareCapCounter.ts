import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { ShareAcceptance } from './ShareAcceptance';

/**
 * Calls one acceptance made through its share in one fixed window of the
 * share's `cap`. The composite primary key is the atomic upsert target.
 * Internal: never exposed, no `publicId`.
 */
@Table({
  tableName: 'share_cap_counters',
  timestamps: false,
})
export class ShareCapCounter extends Model {
  @ForeignKey(() => {
    return ShareAcceptance;
  })
  @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true })
  declare acceptanceId: number;

  @BelongsTo(
    () => {
      return ShareAcceptance;
    },
    { onDelete: 'CASCADE' }
  )
  declare acceptance: ShareAcceptance;

  /** The window's key, as `windowKeyFor` derives it. */
  @Column({ type: DataType.STRING, allowNull: false, primaryKey: true })
  declare windowKey: string;

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare count: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
