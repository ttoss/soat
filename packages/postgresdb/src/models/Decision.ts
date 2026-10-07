import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';

/**
 * One evaluation of a question set against a caller's input: a decider's, or
 * one sent with the request (`questions`, null for a decider's decision).
 *
 * `answers` is written once, when the decision settles; the row's other
 * columns move as it does. The evaluated input is not a column: it is
 * arbitrary caller content, and this table has no retention or purge path.
 *
 * `deciderId` and `generationId` are public ids rather than foreign keys, so a
 * decision outlives the decider that asked and the generation that answered.
 */
@Table({
  tableName: 'decisions',
  indexes: [
    {
      name: 'decisions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'decisions_project_id_created_at_idx',
      fields: ['project_id', 'created_at'],
    },
    {
      name: 'decisions_decider_id_created_at_idx',
      fields: ['decider_id', 'created_at'],
    },
    // The sweep's due set: unsettled rows past their lease.
    {
      name: 'decisions_status_lease_expires_at_idx',
      fields: ['status', 'lease_expires_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Decision) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.decision);
      }
    },
  },
})
export class Decision extends Model {
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

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare deciderId: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare deciderVersion: number | null;

  /** `JSON`, not `JSONB`, for the same key order `Decider.questions` keeps. */
  @Column({ type: DataType.JSON, allowNull: true })
  declare questions: object | null;

  /** `queued` | `running` | `completed` | `failed`. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare answers: object | null;

  /** `{ code, message }` for a `failed` decision. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: object | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare generationId: string | null;

  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: null })
  declare metadata: Record<string, unknown> | null;

  /** Until when the evaluating process owns an unsettled decision. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseExpiresAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
