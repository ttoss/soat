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
 * One `guardrail_evaluation` audit record per guardrail evaluated against a tool
 * call (roadmap task 2.6). A call gated at several scopes produces several rows;
 * the enacted decision is the strictest across them. The record freezes the
 * governing version, the resolved class, the guard outcome, and a flat snapshot
 * of only the vars the expressions referenced — the only way to answer "why did
 * this pass?" after the application's context (or usage counters) have moved on.
 * Append-only: written once at evaluation time, never updated.
 */
@Table({
  tableName: 'guardrail_evaluations',
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: GuardrailEvaluation) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.guardrailEvaluation
        );
      }
    },
  },
})
export class GuardrailEvaluation extends Model {
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

  // The evaluated guardrail's public id. Kept even when the reference is dangling
  // (the guardrail was deleted): the record still names what was referenced.
  @Column({ type: DataType.STRING, allowNull: false })
  declare guardrailId: string;

  // The governing document version; null for a dangling reference (fail-closed C).
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare guardrailVersion: number | null;

  // Where the guardrail was attached: 'project' | 'agent' | 'tool'.
  @Column({ type: DataType.STRING, allowNull: false })
  declare scope: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare toolId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare toolName: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare action: string | null;

  // The resolved action class (or the applied default_class on an invalid result).
  // `class` is a reserved word, so the column is `resolved_class`.
  @Column({ type: DataType.STRING, allowNull: false })
  declare resolvedClass: string;

  // 'execute' | 'route_to_approval' | 'blocked' | 'tripwire'.
  @Column({ type: DataType.STRING, allowNull: false })
  declare decision: string;

  @Column({ type: DataType.BOOLEAN, allowNull: true })
  declare guardResult: boolean | null;

  // 'caller' | 'tool' | 'merged' | 'none'.
  @Column({ type: DataType.STRING, allowNull: false })
  declare contextSource: string;

  // Flat map of only the referenced vars (fully-qualified paths → frozen values).
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare contextSnapshot: object;

  @Column({ type: DataType.STRING, allowNull: true })
  declare agentId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare runId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare generationId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare approvalId: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
