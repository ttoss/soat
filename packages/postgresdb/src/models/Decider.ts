import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Agent } from './Agent';
import { Project } from './Project';

/**
 * A named question set that, evaluated against a caller's state, produces a
 * `Decision` whose answers are confined to each question's declared space.
 *
 * `version` counts the question set only: every write that changes `questions`
 * archives a `DeciderVersion`, and a decision names the version it was
 * answered under, so rewording a level never reinterprets an earlier answer.
 * Name, description and the agent are metadata and leave it untouched.
 */
@Table({
  tableName: 'deciders',
  indexes: [
    {
      name: 'deciders_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'deciders_project_id_name_unique',
      unique: true,
      fields: ['project_id', 'name'],
    },
    { name: 'deciders_agent_id_idx', fields: ['agent_id'] },
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

  /**
   * The agent that answers. RESTRICT rather than CASCADE: deleting the agent
   * would otherwise delete every decider built on it, and with them the only
   * readable record of the criteria its decisions were answered under.
   */
  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare agentId: number;

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'RESTRICT' }
  )
  declare agent: Agent;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  /**
   * Question id → `{ type, instructions, criteria? }`, in the wire shape.
   * `JSON`, not `JSONB`: `JSONB` reorders object keys, and the order of the
   * questions and of a `choice` question's options is the order the model is
   * shown them in.
   */
  @Column({ type: DataType.JSON, allowNull: false })
  declare questions: object;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
