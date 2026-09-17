import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { AiProvider } from './AiProvider';
import { Project } from './Project';

/**
 * A reusable, versioned question set evaluated by a System One model.
 *
 * The decider is to a System One model what an agent is to an LLM: the named
 * configuration a caller invokes, rather than the call itself. Its `questions`
 * bag is the whole behaviour, so `version` is bumped whenever that bag changes
 * — a `Decision` records the version that produced it, and a rubric level
 * edited a month later must not silently reinterpret last month's answers.
 */
@Table({
  tableName: 'deciders',
  indexes: [
    {
      name: 'deciders_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Decider) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.decider);
      }
    },
  },
})
export class Decider extends Model {
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

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  @ForeignKey(() => {
    return AiProvider;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare aiProviderId: number;

  @BelongsTo(() => {
    return AiProvider;
  })
  declare aiProvider: AiProvider;

  // Null falls back to the provider's `default_model` at evaluation time, so a
  // project retargets every decider by editing one provider record.
  @Column({ type: DataType.STRING, allowNull: true })
  declare model: string | null;

  // `{ <question_id>: { type, instructions, criteria? } }` — validated on write
  // by `deciderQuestions.ts` and sent verbatim to the model.
  @Column({ type: DataType.JSONB, allowNull: false })
  declare questions: object;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
