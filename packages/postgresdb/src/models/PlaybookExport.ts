import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { File } from './File';
import { PlaybookCase } from './PlaybookCase';
import { User } from './User';

/**
 * One file rendered from one revision of a final node by one of its
 * transformations. Outside the graph: no node reads it, and whether it is
 * stale is read against the node's current output, never stored.
 */
@Table({
  tableName: 'playbook_exports',
  indexes: [
    {
      name: 'playbook_exports_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'playbook_exports_case_id_node_idx',
      fields: ['case_id', 'node', 'id'],
    },
    {
      name: 'playbook_exports_status_lease_idx',
      fields: ['status', 'lease_expires_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: PlaybookExport) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.playbookExport);
      }
    },
  },
})
export class PlaybookExport extends Model {
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

  /** The final node's key. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare node: string;

  /** The output or confirmation entry rendered. */
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare revision: number;

  /** The version whose transformation rendered it. */
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare playbookVersion: number;

  @Column({ type: DataType.STRING, allowNull: false })
  declare transformation: string;

  @Column({ type: DataType.STRING(16), allowNull: false })
  declare format: string;

  @Column({ type: DataType.STRING(64), allowNull: false })
  declare toolId: string;

  /** `running` | `completed` | `failed`. */
  @Column({ type: DataType.STRING(16), allowNull: false })
  declare status: string;

  /** Null until it succeeds, and again once the file is deleted. */
  @ForeignKey(() => {
    return File;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare fileId: number | null;

  @BelongsTo(
    () => {
      return File;
    },
    { onDelete: 'SET NULL' }
  )
  declare file: File | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: object | null;

  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare createdByUserId: number | null;

  @BelongsTo(() => {
    return User;
  })
  declare createdBy: User | null;

  /**
   * The tool call the write was made on behalf of (`tool_id`, `agent_id`,
   * `generation_id`, `session_id`, `actor_id`), verified from the request's
   * `On-Behalf-Of` assertion; null for a write made as the credential alone.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare onBehalfOf: Record<string, string | null> | null;

  /** Until when a `running` export is known alive; a sweep fails it once past. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseExpiresAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
