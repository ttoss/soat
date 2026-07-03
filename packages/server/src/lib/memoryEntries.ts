import type { MemoryEntrySource } from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import { db } from 'src/db';
import { getEmbedding } from 'src/lib/embedding';
import { pickMergedContent } from 'src/lib/memoryConsolidation';
import * as consolidationCompletion from 'src/lib/memoryConsolidationCompletion';

/**
 * Context needed to consolidate a merge with an LLM. Present only for writes
 * with an agent context (the `write_memory` tool and automatic extraction);
 * absent for manual REST writes, which keep the concatenation merge.
 */
export type MemoryConsolidationContext = {
  agentId: string;
  projectIds?: number[];
  aiProviderId?: string;
  model?: string;
};

const mapMemoryEntry = (
  instance: InstanceType<(typeof db)['MemoryEntry']> & {
    memory?: InstanceType<(typeof db)['Memory']>;
  }
) => {
  return {
    id: instance.publicId,
    memoryId: instance.memory?.publicId,
    content: instance.content,
    sourceType: instance.sourceType,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

export const mergeEntryContent = (args: {
  existing: string;
  incoming: string;
}): string => {
  return `${args.existing}\n${args.incoming}`;
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
  consolidation?: MemoryConsolidationContext;
}): Promise<ReturnType<typeof mapMemoryEntry>> => {
  const match = args.match!;

  // Concatenation is the fallback; when an agent context is available we ask an
  // LLM to consolidate the two facts into a single atomic entry instead.
  const fallback = mergeEntryContent({
    existing: match.content,
    incoming: args.incoming,
  });

  let mergedContent = fallback;
  if (args.consolidation) {
    try {
      const consolidated =
        await consolidationCompletion.runConsolidationCompletion({
          agentId: args.consolidation.agentId,
          projectIds: args.consolidation.projectIds,
          existing: match.content,
          incoming: args.incoming,
          aiProviderId: args.consolidation.aiProviderId,
          model: args.consolidation.model,
        });
      mergedContent = pickMergedContent({ consolidated, fallback });
    } catch {
      // Best-effort: a failed completion must never lose the write, so fall
      // back to the concatenation.
      mergedContent = fallback;
    }
  }

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
  sourceType?: MemoryEntrySource;
  duplicateThreshold?: number;
  updateThreshold?: number;
  consolidation?: MemoryConsolidationContext;
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

      // Step 3b: Related — merge (LLM consolidation when an agent context is
      // available, concatenation otherwise)
      if (score >= updateThreshold) {
        const entry = await mergeAndUpdateEntry({
          match: topMatch,
          incoming: args.content,
          consolidation: args.consolidation,
        });
        return { action: 'updated', entry };
      }
    }
  }

  // Step 3c: New — create
  const entry = await db.MemoryEntry.create({
    memoryId: args.memoryId,
    content: args.content,
    sourceType: args.sourceType ?? 'manual',
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
  sourceType?: MemoryEntrySource;
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
    sourceType: args.sourceType ?? 'manual',
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
