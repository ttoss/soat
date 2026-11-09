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

/** A named set of keyed JSON items, with no embedding and no backing file. */
@Table({
  tableName: 'collections',
  hooks: {
    beforeValidate: (instance: Collection) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.collection);
      }
    },
  },
  indexes: [
    {
      name: 'collections_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'collections_project_id_name_unique',
      unique: true,
      fields: ['project_id', 'name'],
    },
  ],
})
export class Collection extends Model {
  @Column({ type: DataType.STRING(32), allowNull: false })
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

  /**
   * A JSON Schema every item's `data` must satisfy, stored as written: its
   * keywords are its own vocabulary and are never case-converted.
   */
  @Column({ type: DataType.JSON, allowNull: true })
  declare schema: Record<string, unknown> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
