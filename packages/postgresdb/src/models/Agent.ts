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
import { ModelRoute } from './ModelRoute';
import { Project } from './Project';

@Table({
  tableName: 'agents',
  indexes: [
    {
      name: 'agents_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
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

  /**
   * Nullable because an agent resolves its completion model through EITHER a
   * pinned provider (`aiProviderId` + `model`) OR a `modelRouteId` — never
   * both, never neither. The invariant is enforced by
   * `validateModelRouteExclusivity` on every write path.
   */
  @ForeignKey(() => {
    return AiProvider;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare aiProviderId: number | null;

  @BelongsTo(() => {
    return AiProvider;
  })
  declare aiProvider: AiProvider | null;

  @ForeignKey(() => {
    return ModelRoute;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare modelRouteId: number | null;

  @BelongsTo(() => {
    return ModelRoute;
  })
  declare modelRoute: ModelRoute | null;

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

  /**
   * Agent-scope zero-retention setting (#838). `null` (the default) inherits
   * the project's `traceContentMode`; `'none'` opts this agent out of content
   * persistence even when the project stores content.
   *
   * The agent may only tighten: with a `'none'` project, `'full'` here is
   * refused on write, so a project-wide zero-retention mandate cannot be
   * escaped by an agent created later. Mirrors the project-guardrail floor.
   */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare traceContentMode: string | null;

  /**
   * Current config version, starting at 1. Bumped by the shared lib update path
   * only when a write actually changes the config; each bump archives an
   * `AgentVersion` row.
   */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  /**
   * Staged rollout pointer: `{ stable_version, canary_version, canary_percent }`,
   * stored in its wire (snake_case) shape and echoed verbatim. While it is set,
   * every generation serves one of the two named versions' archived configs —
   * never this row — so the live columns act as a draft that ongoing traffic
   * does not see. Null means all traffic serves this row.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare activeRelease: object | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
