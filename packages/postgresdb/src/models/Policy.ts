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

@Table({
  tableName: 'policies',
  indexes: [
    {
      name: 'policies_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    { name: 'policies_project_id_idx', fields: ['project_id'] },
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

  // `null` is a global policy; set, the project whose resources alone its
  // document may grant on.
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

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
