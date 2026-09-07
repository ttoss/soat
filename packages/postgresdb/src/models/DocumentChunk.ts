import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { getEmbeddingDimensions } from '../utils/embedding';
import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Document } from './Document';

@Table({
  tableName: 'document_chunks',
  indexes: [
    {
      name: 'document_chunks_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      // Without it a semantic search scans every vector in scope: the read
      // pattern is only ever `ORDER BY embedding <=> $query LIMIT n` (#1220).
      // Cosine, because that is the operator both search paths order on.
      name: 'document_chunks_embedding_hnsw_idx',
      using: 'hnsw',
      fields: [{ name: 'embedding', operator: 'vector_cosine_ops' }],
    },
  ],
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
    type: DataType.VECTOR(getEmbeddingDimensions()),
    allowNull: true,
  })
  declare embedding: number[] | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
