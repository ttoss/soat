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
 * One evaluation of a decider: the typed answers a System One model returned,
 * frozen against the decider version that asked for them.
 *
 * Append-only, like `guardrail_evaluations` — a decision is evidence of what
 * the system decided at a point in time, and rewriting one would erase the
 * record a later audit reads.
 *
 * The evaluated `state` is deliberately **not** stored. It is whatever the
 * caller was judging — a ticket, a résumé, a message thread — and keeping it
 * would put arbitrary customer content in a table with no retention or purge
 * path of its own. The answers are the durable artefact; a caller that needs
 * the input kept pairs the decision with its own record.
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
      name: 'decisions_decider_id_idx',
      fields: ['decider_id'],
    },
  ],
  updatedAt: false,
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

  // The decider's public id, kept even once the decider is deleted: the record
  // still names what was evaluated.
  @Column({ type: DataType.STRING, allowNull: false })
  declare deciderId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare deciderVersion: number;

  @Column({ type: DataType.STRING, allowNull: false })
  declare model: string;

  // `{ <question_id>: { type, choice|score|noul, probabilities?, legend?,
  // confidence? } }` exactly as the model returned it.
  @Column({ type: DataType.JSONB, allowNull: false })
  declare answers: object;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare usage: object;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
