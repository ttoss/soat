import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Playbook } from './Playbook';
import { PlaybookEntry } from './PlaybookEntry';
import { Project } from './Project';

/**
 * One subject filled against one pinned version of a playbook. Its values are
 * the append-only `PlaybookEntry` rows; node states are computed from them and
 * never stored.
 */
@Table({
  tableName: 'playbook_cases',
  indexes: [
    {
      name: 'playbook_cases_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'playbook_cases_project_id_created_at_idx',
      fields: ['project_id', 'created_at'],
    },
    {
      name: 'playbook_cases_playbook_id_created_at_idx',
      fields: ['playbook_id', 'created_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: PlaybookCase) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.playbookCase);
      }
    },
  },
})
export class PlaybookCase extends Model {
  @Column({
    type: DataType.STRING(32),
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

  /**
   * RESTRICT: a case is the record of what was filled and decided, so its
   * playbook cannot be deleted from under it.
   */
  @ForeignKey(() => {
    return Playbook;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare playbookId: number;

  @BelongsTo(
    () => {
      return Playbook;
    },
    { onDelete: 'RESTRICT' }
  )
  declare playbook: Playbook;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare playbookVersion: number;

  /** Who or what the case is about, as the caller names it. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare subject: string;

  /**
   * The case's revision counter: every entry takes the next value, so a
   * revision names one entry across all nodes and fields.
   */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare revision: number;

  @HasMany(() => {
    return PlaybookEntry;
  })
  declare entries: PlaybookEntry[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
