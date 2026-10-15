import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Playbook } from './Playbook';
import { User } from './User';

/**
 * Immutable archive of a playbook's definition at a given version, which a
 * case pinned to it is evaluated against. Rows are never mutated and a restore
 * appends a new version, so there is no `updatedAt`.
 *
 * Shares its column layout and the engine that reads and writes it with the
 * other `*Version` tables (`src/lib/resourceVersions.ts`).
 */
@Table({
  tableName: 'playbook_versions',
  indexes: [
    {
      name: 'playbook_versions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'playbook_versions_playbook_id_version_unique',
      unique: true,
      fields: ['playbook_id', 'version'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: PlaybookVersion) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.playbookVersion
        );
      }
    },
  },
})
export class PlaybookVersion extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Playbook;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare playbookId: number;

  @BelongsTo(
    () => {
      return Playbook;
    },
    { onDelete: 'CASCADE' }
  )
  declare playbook: Playbook;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  /** `{ definition }` in the wire shape, `JSON` for the key order it keeps. */
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
