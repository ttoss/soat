import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';
import { Task } from './Task';

/**
 * A Workflow is the state-machine *definition*: named states, allowed
 * transitions, guards, and per-state automation. It is the stateful-entity
 * counterpart of an Orchestration (definition) — versioned config, no runtime
 * state. Tasks are the durable instances bound to a workflow.
 */
@Table({
  tableName: 'workflows',
  hooks: {
    beforeValidate: (instance: Workflow) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.workflow);
      }
    },
  },
})
export class Workflow extends Model {
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

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project;

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  // State definitions (§5): { name, initial?, terminal?, kind?, on_enter?, stalled_after? }.
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare states: object[];

  // Allowed moves (§5): { name, from: string[], to, guard?, requires_approval? }.
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare transitions: object[];

  // Optional JSON Schema validated against a task's payload.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare payloadSchema: object | null;

  @HasMany(() => {
    return Task;
  })
  declare tasks: Task[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
