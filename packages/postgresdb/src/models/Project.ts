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

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
