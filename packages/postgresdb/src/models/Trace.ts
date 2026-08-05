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
import { File } from './File';
import { Project } from './Project';

@Table({
  tableName: 'traces',
  indexes: [
    {
      name: 'traces_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'traces_project_id_created_at_idx',
      fields: ['project_id', 'created_at'],
    },
    { name: 'traces_agent_id_idx', fields: ['agent_id'] },
    // Walked by the trace-tree read: a node's children are found by
    // `parent_trace_id`, and a whole tree by `root_trace_id`.
    { name: 'traces_parent_trace_id_idx', fields: ['parent_trace_id'] },
    { name: 'traces_root_trace_id_idx', fields: ['root_trace_id'] },
  ],
  hooks: {
    beforeValidate: (instance: Trace) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
      }
    },
  },
})
export class Trace extends Model {
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

  @ForeignKey(() => {
    return File;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare fileId: number | null;

  @BelongsTo(
    () => {
      return File;
    },
    { onDelete: 'RESTRICT' }
  )
  declare file: File | null;

  @ForeignKey(() => {
    return Trace;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare parentTraceId: number | null;

  @BelongsTo(
    () => {
      return Trace;
    },
    { foreignKey: 'parentTraceId', as: 'parentTrace', onDelete: 'RESTRICT' }
  )
  declare parentTrace: Trace | null;

  @ForeignKey(() => {
    return Trace;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare rootTraceId: number | null;

  @BelongsTo(
    () => {
      return Trace;
    },
    { foreignKey: 'rootTraceId', as: 'rootTrace', onDelete: 'RESTRICT' }
  )
  declare rootTrace: Trace | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare stepCount: number;

  // Structured error payload recorded when a generation in this trace fails
  // (e.g. upstream AI provider errors). Cleared by a content purge: an error
  // payload can carry a tool's request/response bodies, so it is content and
  // not part of the auditable skeleton.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: Record<string, unknown> | null;

  // Content-purge marker. When set, the trace's steps file has been deleted
  // from storage and its content fields cleared; the row survives as an
  // auditable skeleton (ids, timestamps, step count) so a purge is provable
  // rather than indistinguishable from a resource that never existed.
  // The principal pair mirrors Generation's `startedByPrincipal*` columns.
  @Column({ type: DataType.DATE, allowNull: true })
  declare contentRedactedAt: Date | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare contentRedactedByPrincipalType: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare contentRedactedByPrincipalId: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
