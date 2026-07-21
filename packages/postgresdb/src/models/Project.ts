import { Column, DataType, Model, Table } from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';

@Table({
  tableName: 'projects',
  hooks: {
    beforeValidate: (instance: Project) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.project);
      }
    },
  },
})
export class Project extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare name: string;

  // Public IDs of guardrails attached at the project scope — the baseline /
  // central-mandate floor governing every tool call by every agent in the
  // project (guardrails.md — Attachment).
  @Column({ type: DataType.JSONB, allowNull: true })
  declare guardrailIds: string[] | null;

  // Maximum number of orchestration runs of this project that may be actively
  // driven at once. `null` (the default) means unlimited. Enforced at queue
  // claim time: while the project has this many runs holding a claimed,
  // lease-valid task, further tasks stay queued until a slot frees. Only
  // actively-driven runs occupy a slot — parked (`sleeping`/`awaiting_input`)
  // runs hold none (orchestration-queue PRD, D8/D9).
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare maxConcurrentRuns: number | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
