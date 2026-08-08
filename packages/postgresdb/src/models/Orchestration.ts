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
import { OrchestrationRun } from './OrchestrationRun';
import { OrchestrationVersion } from './OrchestrationVersion';
import { Project } from './Project';

@Table({
  tableName: 'orchestrations',
  indexes: [
    {
      name: 'orchestrations_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Orchestration) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.orchestration);
      }
    },
  },
})
export class Orchestration extends Model {
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
   * Incremented on every write that changes the graph (`nodes`, `edges`,
   * `stateSchema`, `inputSchema`); each version is archived as an
   * `OrchestrationVersion`. A run pins the version it started on, so editing the
   * graph never re-shapes a run already in flight (#872) — which makes these
   * columns a *draft* for runs started from now on, not a live rewrite of the
   * ones already executing. Metadata-only edits leave it untouched.
   */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare nodes: object[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare edges: object[];

  @Column({ type: DataType.JSONB, allowNull: true })
  declare stateSchema: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare inputSchema: object | null;

  @HasMany(() => {
    return OrchestrationRun;
  })
  declare runs: OrchestrationRun[];

  @HasMany(() => {
    return OrchestrationVersion;
  })
  declare versions: OrchestrationVersion[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
