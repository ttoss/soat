import type { MemoryEntrySource } from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import { Ollama } from 'ollama';
import { db } from 'src/db';
import { getEmbedding } from 'src/lib/embedding';

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

export const mergeEntryContent = async (args: {
  existing: string;
  incoming: string;
}): Promise<string> => {
  const provider = process.env.EMBEDDING_PROVIDER;
  const model = process.env.EMBEDDING_MODEL;

  if (provider !== 'ollama' || !model) {
    return args.incoming;
  }

  const host = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const ollama = new Ollama({ host });

  const prompt = `You are a knowledge merging assistant. Given an existing fact and a new fact, produce a single updated fact that combines both. If they contradict, prefer the new information. Return only the merged fact, nothing else.\n\nExisting fact: ${args.existing}\nNew fact: ${args.incoming}\n\nMerged fact:`;

  const stream = await ollama.chat({
    model,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  });

  let merged = '';
  for await (const chunk of stream) {
    merged += chunk.message.content;
  }

  return merged.trim() || args.incoming;
};

const findTopSimilarEntry = async (args: {
  memoryId: number;
  embeddingLiteral: string;
}) => {
  return db.MemoryEntry.findOne({
    where: {
      memoryId: args.memoryId,
      embedding: { [Op.not]: null },
    },
    attributes: {
      include: [
        [
          db.MemoryEntry.sequelize!.literal(
            `embedding <=> '${args.embeddingLiteral}'`
          ),
          'distance',
        ],
      ],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    include: [{ model: db.Memory, as: 'memory' }] as any,
    order: db.MemoryEntry.sequelize!.literal(
      `embedding <=> '${args.embeddingLiteral}'`
    ),
  });
};

const mergeAndUpdateEntry = async (args: {
  match: Awaited<ReturnType<typeof findTopSimilarEntry>>;
  incoming: string;
}): Promise<ReturnType<typeof mapMemoryEntry>> => {
  const match = args.match!;
  const mergedContent = await mergeEntryContent({
    existing: match.content,
    incoming: args.incoming,
  });

  match.content = mergedContent;
  try {
    match.embedding = await getEmbedding({ text: mergedContent });
  } catch {
    // embedding is optional
  }

  await match.save();

  const withMemory = await db.MemoryEntry.findOne({
    where: { id: match.id },
    include: [{ model: db.Memory, as: 'memory' }],
  });

  return mapMemoryEntry(withMemory!);
};

export const writeMemoryEntry = async (args: {
  memoryId: number;
  content: string;
  source?: MemoryEntrySource;
  duplicateThreshold?: number;
  updateThreshold?: number;
}): Promise<{
  action: 'created' | 'updated' | 'skipped';
  entry: ReturnType<typeof mapMemoryEntry>;
}> => {
  const duplicateThreshold = args.duplicateThreshold ?? 0.95;
  const updateThreshold = args.updateThreshold ?? 0.75;

  // Step 1: Generate embedding for incoming content
  let embedding: number[] | null = null;
  try {
    embedding = await getEmbedding({ text: args.content });
  } catch {
    // embedding is optional
  }

  // Step 2: Search for the most similar existing entry (only when we have an embedding)
  if (embedding) {
    const embeddingLiteral = `[${embedding.join(',')}]`;
    const topMatch = await findTopSimilarEntry({
      memoryId: args.memoryId,
      embeddingLiteral,
    });

    if (topMatch) {
      const distance = parseFloat(
        (topMatch.getDataValue('distance') as string) ?? '1'
      );
      const score = 1 - distance;

      // Step 3a: Duplicate — skip
      if (score >= duplicateThreshold) {
        return { action: 'skipped', entry: mapMemoryEntry(topMatch) };
      }

      // Step 3b: Related — merge via LLM
      if (score >= updateThreshold) {
        const entry = await mergeAndUpdateEntry({
          match: topMatch,
          incoming: args.content,
        });
        return { action: 'updated', entry };
      }
    }
  }

  // Step 3c: New — create
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

  return { action: 'created', entry: mapMemoryEntry(withMemory!) };
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
