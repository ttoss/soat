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
import { ProjectGroup } from './ProjectGroup';

@Table({
  tableName: 'policies',
  indexes: [
    {
      name: 'policies_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    { name: 'policies_project_id_idx', fields: ['project_id'] },
    {
      name: 'policies_project_group_id_idx',
      fields: ['project_group_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Policy) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.policy);
      }
    },
  },
})
export class Policy extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  // `null` with no `projectGroupId` is a global policy; set, the project whose
  // resources alone its document may grant on.
  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare projectId: number | null;

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project | null;

  /**
   * The project group whose own resources and projects alone its document may
   * grant on. Set only on a policy with no `projectId`.
   */
  @ForeignKey(() => {
    return ProjectGroup;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare projectGroupId: number | null;

  @BelongsTo(
    () => {
      return ProjectGroup;
    },
    { foreignKey: 'projectGroupId', as: 'projectGroup', onDelete: 'CASCADE' }
  )
  declare projectGroup: ProjectGroup | null;

  @Column({
    type: DataType.STRING,
    allowNull: true,
  })
  declare name: string | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
  })
  declare description: string | null;

  @Column({
    type: DataType.JSON,
    allowNull: false,
  })
  declare document: object;

  /** A global policy every tenant credential may read; never set on any other. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare published: boolean;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
