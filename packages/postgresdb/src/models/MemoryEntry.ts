import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
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
    unique: true,
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

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
