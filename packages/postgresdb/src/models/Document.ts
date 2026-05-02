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
    type: DataType.JSONB,
    allowNull: true,
  })
  declare tags: Record<string, string> | null;

  @Column({
    type: DataType.VECTOR(
      (() => {
        const dim = Number(process.env.EMBEDDING_DIMENSIONS);
        if (!dim) {
          throw new Error(
            'EMBEDDING_DIMENSIONS environment variable must be set to a positive integer'
          );
        }
        return dim;
      })()
    ),
    allowNull: true,
  })
  declare embedding: number[] | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
