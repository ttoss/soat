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

/**
 * Short-lived, single-use token that authorizes a direct file upload without a
 * bearer credential — the local-storage equivalent of an S3 presigned URL.
 *
 * The `publicId` (prefixed `upt_`) is the token value handed to the client.
 */
@Table({
  tableName: 'upload_tokens',
  hooks: {
    beforeValidate: (instance: UploadToken) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.uploadToken);
      }
    },
  },
})
export class UploadToken extends Model {
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

  @Column({ type: DataType.STRING(1024), allowNull: true })
  declare path: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare filename?: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare contentType?: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare usedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
