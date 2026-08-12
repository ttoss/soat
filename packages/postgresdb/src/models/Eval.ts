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
import { Dataset } from './Dataset';
import { Project } from './Project';

/**
 * A repeatable test suite: an agent under test, the dataset to run it against,
 * and the scorers its outputs are judged by (docs/prd-evaluations.md).
 *
 * Scorer configuration is frozen here rather than read from the agent at run
 * time — an `output_schema` scorer carries its own `schema` — so two runs of
 * the same Eval are always scored against the same criteria and their
 * comparison measures the agent, not the config drifting underneath it.
 */
@Table({
  tableName: 'evals',
  indexes: [
    {
      name: 'evals_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'evals_project_id_name_unique',
      unique: true,
      fields: ['project_id', 'name'],
    },
    { name: 'evals_project_id_idx', fields: ['project_id'] },
    { name: 'evals_agent_id_idx', fields: ['agent_id'] },
  ],
  hooks: {
    beforeValidate: (instance: Eval) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.evaluation);
      }
    },
  },
})
export class Eval extends Model {
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

  /** The agent under test. */
  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare agentId: number;

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'CASCADE' }
  )
  declare agent: Agent;

  @ForeignKey(() => {
    return Dataset;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare datasetId: number;

  @BelongsTo(
    () => {
      return Dataset;
    },
    { onDelete: 'CASCADE' }
  )
  declare dataset: Dataset;

  /** Array of scorer configs — a discriminated union on `type`. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare scorers: unknown;

  /**
   * 0–1. A run `passed` iff its **pass rate** (passed items over non-errored
   * items) is at least this. Null leaves `EvalRun.passed` null — the Eval
   * reports scores without gating on them.
   */
  @Column({ type: DataType.DECIMAL, allowNull: true })
  declare passThreshold: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
