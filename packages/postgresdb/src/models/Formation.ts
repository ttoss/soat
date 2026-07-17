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
import { FormationResource } from './FormationResource';
import { Project } from './Project';

@Table({
  tableName: 'formations',
  hooks: {
    beforeValidate: (instance: Formation) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.formation);
      }
    },
  },
  indexes: [{ unique: true, fields: ['project_id', 'name'] }],
})
export class Formation extends Model {
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

  @HasMany(() => {
    return FormationResource;
  })
  declare formationResources: FormationResource[];

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare template: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare outputs: Record<string, string> | null;

  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'creating' })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, unknown> | null;

  // Top-level template `metadata` after parameter (`sub`/`param`) and resource
  // (`ref`) substitution at the last deploy. The raw expressions are preserved
  // in `template.metadata`; this column holds the resolved view (mirrors how
  // `outputs` relates to `template.outputs`).
  @Column({ type: DataType.JSONB, allowNull: true })
  declare resolvedMetadata: Record<string, unknown> | null;

  // Parameter values applied at the last deploy, for auditability. `no_echo`
  // parameters are masked.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare resolvedParameters: Record<string, string> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
