import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { File } from './File';

@Table({
  tableName: 'documents',
  hooks: {
    beforeValidate: (instance: Document) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.document);
      }
    },
  },
})
export class Document extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return File;
  })
  @Column({ type: DataType.INTEGER, allowNull: false, unique: true })
  declare fileId: number;

  @BelongsTo(() => {
    return File;
  })
  declare file: File;

  @Column({
    type: DataType.STRING,
    allowNull: true,
  })
  declare title: string | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
  })
  declare metadata: string | null;

  @Column({
    type: DataType.ARRAY(DataType.TEXT),
    allowNull: true,
  })
  declare tags: string[] | null;

  @Column({
    type: DataType.VECTOR(1024),
    allowNull: true,
  })
  declare embedding: number[] | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
