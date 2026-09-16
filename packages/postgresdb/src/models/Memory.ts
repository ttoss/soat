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
import { MemoryStore } from './MemoryStore';

export const MEMORY_SOURCES = ['manual', 'conversation'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

@Table({
  tableName: 'memories',
  indexes: [
    {
      name: 'memories_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      // Without it a semantic search scans every vector in scope: the read
      // pattern is only ever `ORDER BY embedding <=> $query LIMIT n` (#1220).
      // Cosine, because that is the operator both search paths order on.
      name: 'memories_embedding_hnsw_idx',
      using: 'hnsw',
      fields: [{ name: 'embedding', operator: 'vector_cosine_ops' }],
    },
  ],
  hooks: {
    beforeValidate: (instance: Memory) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.memory);
      }
    },
  },
})
export class Memory extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

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

  /**
   * Provenance — whether there is a source to point at, not how the write was
   * made. `conversation` means `sourceId` names the conversation the fact was
   * learned in; `manual` means there is nothing to point at, which covers a
   * direct API write *and* an agent write outside a conversation (the
   * `write_memory` tool, extraction on a direct generation).
   */
  @Column({
    type: DataType.STRING,
    allowNull: false,
    defaultValue: 'manual',
  })
  declare sourceType: MemorySource;

  /**
   * The source's **public** id — a conversation id today — deliberately a
   * loose pointer rather than a foreign key, so the column can name a second
   * kind of source without a second column. The trade is real: nothing
   * enforces it, so deleting a conversation leaves the id dangling. That is
   * the intended reading — the fact was learned there, and the record of
   * where outlives the conversation itself.
   */
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare sourceId: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare tags: Record<string, string> | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, unknown> | null;

  @Column({
    type: DataType.VECTOR(getEmbeddingDimensions()),
    allowNull: true,
  })
  declare embedding: number[] | null;

  /**
   * Temporal invalidation — `null` means currently valid. A superseded memory
   * is retired rather than rewritten: it stays readable for audit and points
   * at the memory that replaced it. The LLM arbitration that sets these ships
   * later (Memories 5a); the columns and API shape land now because supersede
   * history cannot be backfilled.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  declare invalidatedAt: Date | null;

  @ForeignKey(() => {
    return Memory;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare supersededByMemoryId: number | null;

  @BelongsTo(
    () => {
      return Memory;
    },
    {
      foreignKey: 'supersededByMemoryId',
      as: 'supersededByMemory',
      onDelete: 'SET NULL',
    }
  )
  declare supersededByMemory: Memory | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
