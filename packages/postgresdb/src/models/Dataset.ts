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
import { DatasetItem } from './DatasetItem';
import { Project } from './Project';

/**
 * A project-scoped, named collection of test cases an Eval runs an agent
 * against (the evaluations module doc).
 *
 * Datasets are operator-owned **fixtures**: nothing in the platform's content
 * purge touches them, because a test suite must not silently stop being
 * runnable because of an unrelated erasure request.
 */
@Table({
  tableName: 'datasets',
  indexes: [
    {
      name: 'datasets_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'datasets_project_id_name_unique',
      unique: true,
      fields: ['project_id', 'name'],
    },
    { name: 'datasets_project_id_idx', fields: ['project_id'] },
  ],
  hooks: {
    beforeValidate: (instance: Dataset) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.dataset);
      }
    },
  },
})
export class Dataset extends Model {
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

  @HasMany(() => {
    return DatasetItem;
  })
  declare items: DatasetItem[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
