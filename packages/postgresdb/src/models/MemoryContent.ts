import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { getEmbeddingDimensions } from '../utils/embedding';
import { MemoryStore } from './MemoryStore';

/**
 * One row per distinct text per store — the content a memory currently holds
 * and the content an assertion claimed, stored once.
 *
 * Both `memories` and `memory_assertions` point here, so an assertion that
 * restates text already in the store costs no embedding call (the hash is hit
 * before the embedder is reached) and a memory carries no copy of its own.
 *
 * Deliberately not a `Document`: that would be a `File` row, a storage-provider
 * write, a `Document` and its chunks for a ten-word sentence, on the in-turn
 * tool path. The vector cannot leave Postgres and dwarfs the text, so nothing
 * meaningful would move out of the database either.
 */
@Table({
  tableName: 'memory_contents',
  indexes: [
    {
      // The dedup key. Unique per store, not globally: two projects asserting
      // the same sentence must not share a row, and a store is the unit a
      // policy and a CASCADE both act on.
      name: 'memory_contents_store_hash_unique',
      unique: true,
      fields: ['memory_store_id', 'content_hash'],
    },
    {
      // Moved here from `memories` with the vector itself: the read pattern is
      // still `ORDER BY embedding <=> $query LIMIT n`, now reached
      // through the memory's `content_id` so the validity filter stays on the
      // memory row.
      name: 'memory_contents_embedding_hnsw_idx',
      using: 'hnsw',
      fields: [{ name: 'embedding', operator: 'vector_cosine_ops' }],
    },
  ],
})
export class MemoryContent extends Model {
  @ForeignKey(() => {
    return MemoryStore;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare memoryStoreId: number;

  @BelongsTo(
    () => {
      return MemoryStore;
    },
    { onDelete: 'CASCADE' }
  )
  declare memoryStore: MemoryStore;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare content: string;

  /** sha256 of the normalized content; see `hashMemoryContent`. */
  @Column({ type: DataType.STRING(64), allowNull: false })
  declare contentHash: string;

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
