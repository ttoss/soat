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

@Table({
  tableName: 'agents',
  hooks: {
    beforeValidate: (instance: Agent) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.agent);
      }
    },
  },
})
export class Agent extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
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

  @ForeignKey(() => {
    return AiProvider;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare aiProviderId: number;

  @BelongsTo(() => {
    return AiProvider;
  })
  declare aiProvider: AiProvider;

  @Column({ type: DataType.STRING, allowNull: true })
  declare name: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare instructions: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare model: string | null;

  // Canonical agent↔tool attachment: array of binding objects
  // `{ toolId | tool }`. Single source of truth once written;
  // the legacy `toolIds`/`tools` columns below remain only so rows created
  // before this column existed keep reading (normalized lazily at read time).
  @Column({ type: DataType.JSONB, allowNull: true })
  declare toolBindings: object[] | null;

  // Deprecated: pre-toolBindings storage. Not written by new code paths.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare toolIds: string[] | null;

  // Deprecated: pre-toolBindings storage. Not written by new code paths.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare tools: object[] | null;

  @Column({ type: DataType.INTEGER, allowNull: true, defaultValue: 20 })
  declare maxSteps: number | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare toolChoice: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare stopConditions: object[] | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare activeToolIds: string[] | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare stepRules: object[] | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare boundaryPolicy: object | null;

  @Column({ type: DataType.FLOAT, allowNull: true })
  declare temperature: number | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare maxContextMessages: number | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare knowledgeConfig: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare outputSchema: object | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare singleSessionPerActor: boolean;

  // Public IDs of guardrails attached at the agent scope. A guardrail here
  // governs every tool call the agent makes, across all its bindings
  // (guardrails.md — Attachment).
  @Column({ type: DataType.JSONB, allowNull: true })
  declare guardrailIds: string[] | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
