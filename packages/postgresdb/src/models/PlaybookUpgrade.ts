import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { PlaybookCase } from './PlaybookCase';
import { User } from './User';

/** A case moved from one version of its playbook to another, and what moved. */
@Table({
  tableName: 'playbook_upgrades',
  indexes: [
    {
      name: 'playbook_upgrades_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'playbook_upgrades_case_id_idx',
      fields: ['case_id', 'id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: PlaybookUpgrade) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.playbookUpgrade
        );
      }
    },
  },
})
export class PlaybookUpgrade extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return PlaybookCase;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare caseId: number;

  @BelongsTo(
    () => {
      return PlaybookCase;
    },
    { onDelete: 'CASCADE' }
  )
  declare case: PlaybookCase;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare fromVersion: number;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare toVersion: number;

  /** The nodes added, removed and changed between the two versions. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare diff: object;

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

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
