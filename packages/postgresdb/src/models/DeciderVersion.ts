import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Decider } from './Decider';
import { User } from './User';

/**
 * Immutable archive of a decider's question set at a given version, so the
 * criteria behind any decision stay readable after the decider changes. Rows
 * are never mutated and a restore appends a new version, so there is no
 * `updatedAt`.
 *
 * Shares its column layout and the engine that reads and writes it with the
 * other `*Version` tables (`src/lib/resourceVersions.ts`).
 */
@Table({
  tableName: 'decider_versions',
  indexes: [
    {
      name: 'decider_versions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'decider_versions_decider_id_version_unique',
      unique: true,
      fields: ['decider_id', 'version'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: DeciderVersion) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.deciderVersion);
      }
    },
  },
})
export class DeciderVersion extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Decider;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare deciderId: number;

  @BelongsTo(
    () => {
      return Decider;
    },
    { onDelete: 'CASCADE' }
  )
  declare decider: Decider;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  /**
   * `{ questions }` in the wire shape the deciders spec documents. `JSON` for
   * the key order `Decider.questions` keeps, so a restore replays it.
   */
  @Column({ type: DataType.JSON, allowNull: false })
  declare config: object;

  @Column({ type: DataType.STRING, allowNull: true })
  declare label: string | null;

  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare createdByUserId: number | null;

  @BelongsTo(() => {
    return User;
  })
  declare createdBy: User | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
