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
import { User } from './User';

@Table({
  tableName: 'api_keys',
  hooks: {
    beforeValidate: (instance: ApiKey) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.apiKey);
      }
    },
  },
})
export class ApiKey extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare userId: number;

  @BelongsTo(() => {
    return User;
  })
  declare user: User;

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
    return ProjectPolicy;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare policyId: number;

  @BelongsTo(() => {
    return ProjectPolicy;
  })
  declare policy: ProjectPolicy;

  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare name: string;

  /**
   * First 8 characters of the raw API key. Stored in plaintext to allow
   * fast DB lookup before running bcrypt.compare against keyHash.
   */
  @Column({
    type: DataType.STRING(8),
    allowNull: false,
  })
  declare keyPrefix: string;

  /**
   * Bcrypt hash of the raw API key value (soat_sk_<random>).
   * The raw key is shown once at creation and never stored in plaintext.
   */
  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare keyHash: string;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
