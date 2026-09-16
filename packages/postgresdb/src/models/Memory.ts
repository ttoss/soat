import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { MemoryContent } from './MemoryContent';
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
      // Every read joins the shared content row for the text and the vector.
      name: 'memories_content_id_idx',
      fields: ['content_id'],
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

  /**
   * The text this memory currently holds, shared with every assertion that
   * stated it. The memory keeps identity and validity; the content row keeps
   * the text and its vector.
   */
  @ForeignKey(() => {
    return MemoryContent;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare contentId: number;

  @BelongsTo(
    () => {
      return MemoryContent;
    },
    { foreignKey: 'contentId', as: 'content', onDelete: 'CASCADE' }
  )
  declare content: MemoryContent;

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

  /**
   * Temporal invalidation — `null` means currently valid. A superseded memory
   * is retired rather than rewritten: it stays readable for audit and points
   * at the memory that replaced it.
   *
   * Validity lives here and only here. It is the filter on every hot read
   * (dedup, listing, knowledge search), and a future "forget this" is
   * `invalidatedAt` set with no replacement — a state of the memory that no
   * supersede assertion could express.
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
