import { Column, DataType, Model, Table } from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';

@Table({
  tableName: 'files',
  hooks: {
    beforeValidate: (instance: File) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.file);
      }
    },
  },
})
export class File extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @Column({ type: DataType.STRING })
  declare filename?: string;

  @Column({ type: DataType.STRING })
  declare contentType?: string;

  @Column({ type: DataType.INTEGER })
  declare size?: number;

  @Column({ type: DataType.ENUM('local', 's3', 'gcs') })
  declare storageType: 'local' | 's3' | 'gcs';

  @Column({ type: DataType.STRING })
  declare storagePath: string;

  @Column({ type: DataType.TEXT })
  declare metadata?: string; // JSON string

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
