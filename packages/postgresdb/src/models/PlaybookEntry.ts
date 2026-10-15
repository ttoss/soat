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

/**
 * One write to one field of a case: a manual input, a node's output, a
 * confirmation or a rejection. Append-only: the latest entry of a field is its
 * value, and every earlier one stays readable.
 */
@Table({
  tableName: 'playbook_entries',
  indexes: [
    {
      name: 'playbook_entries_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'playbook_entries_case_id_revision_unique',
      unique: true,
      fields: ['case_id', 'revision'],
    },
    {
      name: 'playbook_entries_case_id_node_revision_idx',
      fields: ['case_id', 'node', 'revision'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: PlaybookEntry) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.playbookEntry);
      }
    },
  },
})
export class PlaybookEntry extends Model {
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
  declare revision: number;

  /** The node key, stable across playbook versions. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare node: string;

  /** `input` | `output` | `confirmation` | `rejection`. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare kind: string;

  /** The input's name for an `input` entry, null otherwise. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare field: string | null;

  /** `JSON`, not `JSONB`, so an object value reads back in its key order. */
  @Column({ type: DataType.JSON, allowNull: true })
  declare value: unknown;

  /** What an output, confirmation or rejection was decided on. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare basis: object | null;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare playbookVersion: number;

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
