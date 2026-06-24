import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Document } from './Document';

@Table({
  tableName: 'document_chunks',
  hooks: {
    beforeValidate: (instance: DocumentChunk) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.documentChunk);
      }
    },
  },
})
export class DocumentChunk extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Document;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare documentId: number;

  @BelongsTo(
    () => {
      return Document;
    },
    { onDelete: 'CASCADE' }
  )
  declare document: Document;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare content: string;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare pageNumber: number | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare chunkIndex: number;

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
