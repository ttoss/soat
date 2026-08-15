import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Conversation } from './Conversation';
import { Generation } from './Generation';
import { Memory } from './Memory';

export const MEMORY_ENTRY_SOURCES = [
  'manual',
  'agent',
  'extraction',
  'orchestration',
] as const;
export type MemoryEntrySource = (typeof MEMORY_ENTRY_SOURCES)[number];

@Table({
  tableName: 'memory_entries',
  indexes: [
    {
      name: 'memory_entries_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: MemoryEntry) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.memoryEntry);
      }
    },
  },
})
export class MemoryEntry extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Memory;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare memoryId: number;

  @BelongsTo(
    () => {
      return Memory;
    },
    { onDelete: 'CASCADE' }
  )
  declare memory: Memory;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare content: string;

  @Column({
    type: DataType.STRING,
    allowNull: false,
    defaultValue: 'manual',
  })
  declare sourceType: MemoryEntrySource;

  @Column({ type: DataType.ARRAY(DataType.STRING), allowNull: true })
  declare tags: string[] | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, unknown> | null;

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

  /**
   * Provenance — the generation/conversation turn that produced this fact,
   * answering "why does the agent believe this". Populated by the
   * `write_memory` tool and the extraction write path; null for manual REST
   * writes and orchestration node writes, which have no generation.
   *
   * `SET NULL` rather than `CASCADE` on both: deleting a generation or a
   * conversation must never delete the facts learned from it — the entry
   * outlives its source and simply loses the back-reference.
   */
  @ForeignKey(() => {
    return Generation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare sourceGenerationId: number | null;

  @BelongsTo(
    () => {
      return Generation;
    },
    {
      foreignKey: 'sourceGenerationId',
      as: 'sourceGeneration',
      onDelete: 'SET NULL',
    }
  )
  declare sourceGeneration: Generation | null;

  @ForeignKey(() => {
    return Conversation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare sourceConversationId: number | null;

  @BelongsTo(
    () => {
      return Conversation;
    },
    {
      foreignKey: 'sourceConversationId',
      as: 'sourceConversation',
      onDelete: 'SET NULL',
    }
  )
  declare sourceConversation: Conversation | null;

  /**
   * Temporal invalidation — `null` means currently valid. A superseded entry
   * is retired rather than rewritten: it stays readable for audit and points
   * at the entry that replaced it. The LLM arbitration that sets these ships
   * later (Memories 5a); the columns and API shape land now because supersede
   * history cannot be backfilled.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  declare invalidatedAt: Date | null;

  @ForeignKey(() => {
    return MemoryEntry;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare supersededByEntryId: number | null;

  @BelongsTo(
    () => {
      return MemoryEntry;
    },
    {
      foreignKey: 'supersededByEntryId',
      as: 'supersededByEntry',
      onDelete: 'SET NULL',
    }
  )
  declare supersededByEntry: MemoryEntry | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
