import { db } from 'src/db';
import { getEmbedding } from 'src/lib/embedding';
import type { MemoryEntrySource } from '@soat/postgresdb';

const mapMemoryEntry = (
  instance: InstanceType<(typeof db)['MemoryEntry']> & {
    memory?: InstanceType<(typeof db)['Memory']>;
  }
) => {
  return {
    id: instance.publicId,
    memoryId: instance.memory?.publicId,
    content: instance.content,
    source: instance.source,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

export const createMemoryEntry = async (args: {
  memoryId: number;
  content: string;
  source?: MemoryEntrySource;
}) => {
  let embedding: number[] | null = null;

  try {
    embedding = await getEmbedding({ text: args.content });
  } catch {
    // embedding is optional — continue without it
  }

  const entry = await db.MemoryEntry.create({
    memoryId: args.memoryId,
    content: args.content,
    source: args.source ?? 'manual',
    embedding,
  });

  const withMemory = await db.MemoryEntry.findOne({
    where: { id: entry.id },
    include: [{ model: db.Memory, as: 'memory' }],
  });

  return mapMemoryEntry(withMemory!);
};

export const listMemoryEntries = async (args: { memoryId: number }) => {
  const entries = await db.MemoryEntry.findAll({
    where: { memoryId: args.memoryId },
    include: [{ model: db.Memory, as: 'memory' }],
    order: [['createdAt', 'ASC']],
  });
  return entries.map(mapMemoryEntry);
};

export const getMemoryEntry = async (args: { id: string }) => {
  const entry = await db.MemoryEntry.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Memory, as: 'memory' }],
  });
  if (!entry) return null;
  return mapMemoryEntry(entry);
};

export const updateMemoryEntry = async (args: {
  id: string;
  content?: string;
}) => {
  const entry = await db.MemoryEntry.findOne({
    where: { publicId: args.id },
  });
  if (!entry) return null;

  if (args.content !== undefined) {
    entry.content = args.content;

    try {
      entry.embedding = await getEmbedding({ text: args.content });
    } catch {
      // embedding is optional — continue without it
    }
  }

  await entry.save();

  const withMemory = await db.MemoryEntry.findOne({
    where: { id: entry.id },
    include: [{ model: db.Memory, as: 'memory' }],
  });

  return mapMemoryEntry(withMemory!);
};

export const deleteMemoryEntry = async (args: {
  id: string;
}): Promise<'deleted' | null> => {
  const entry = await db.MemoryEntry.findOne({
    where: { publicId: args.id },
  });
  if (!entry) return null;
  await entry.destroy();
  return 'deleted';
};
