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
import { ProjectPolicy } from './ProjectPolicy';

@Table({
  tableName: 'webhooks',
  hooks: {
    beforeValidate: (instance: Webhook) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.webhook);
      }
    },
  },
})
export class Webhook extends Model {
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

  @ForeignKey(() => {
    return ProjectPolicy;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare policyId: number | null;

  @BelongsTo(
    () => {
      return ProjectPolicy;
    },
    { onDelete: 'SET NULL' }
  )
  declare policy: ProjectPolicy | null;

  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare name: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
  })
  declare description: string | null;

  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare url: string;

  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare secret: string;

  @Column({
    type: DataType.ARRAY(DataType.STRING),
    allowNull: false,
  })
  declare events: string[];

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  })
  declare active: boolean;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
