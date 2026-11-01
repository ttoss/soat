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
  @Column({ type: DataType.JSON, allowNull: false })
  declare diff: object;

  @Column({ type: DataType.STRING(16), allowNull: true })
  declare createdByPrincipalType: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare createdByPrincipalId: string | null;

  /**
   * The tool call the write was made on behalf of (`tool_id`, `agent_id`,
   * `generation_id`, `session_id`, `actor_id`), verified from the request's
   * `On-Behalf-Of` assertion; null for a write made as the credential alone.
   */
  @Column({ type: DataType.JSON, allowNull: true })
  declare onBehalfOf: Record<string, string | null> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
