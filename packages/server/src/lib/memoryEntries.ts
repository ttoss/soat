import type { MemoryEntrySource } from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import { db } from 'src/db';
import { getEmbedding } from 'src/lib/embedding';
import { pickMergedContent } from 'src/lib/memoryConsolidation';
import * as consolidationCompletion from 'src/lib/memoryConsolidationCompletion';
import { paginatedList } from 'src/lib/pagination';

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
    tags: instance.tags ?? null,
    metadata: instance.metadata ?? null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

/**
 * Merges the incoming entry's tags/metadata into an existing entry during a
 * consolidation write, so tags accumulate rather than being lost. Tags are
 * unioned; metadata is shallow-merged with incoming keys winning.
 */
const mergeEntryTags = (args: {
  existing: string[] | null;
  incoming?: string[] | null;
}): string[] | null => {
  if (!args.incoming || args.incoming.length === 0) return args.existing;
  return [...new Set([...(args.existing ?? []), ...args.incoming])];
};

const mergeEntryMetadata = (args: {
  existing: Record<string, unknown> | null;
  incoming?: Record<string, unknown> | null;
}): Record<string, unknown> | null => {
  if (!args.incoming) return args.existing;
  return { ...(args.existing ?? {}), ...args.incoming };
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
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
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
  match.tags = mergeEntryTags({ existing: match.tags, incoming: args.tags });
  match.metadata = mergeEntryMetadata({
    existing: match.metadata,
    incoming: args.metadata,
  });
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

type WriteMemoryEntryResult = {
  action: 'created' | 'updated' | 'skipped';
  entry: ReturnType<typeof mapMemoryEntry>;
};

/**
 * Finds the most similar existing entry and decides whether the incoming write
 * is a duplicate (skip) or a related fact (merge). Returns the resolved result,
 * or null when no similar entry exists and the caller should create a new one.
 */
const resolveDedupAction = async (args: {
  memoryId: number;
  content: string;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
  duplicateThreshold?: number;
  updateThreshold?: number;
  consolidation?: MemoryConsolidationContext;
  embedding: number[] | null;
}): Promise<WriteMemoryEntryResult | null> => {
  if (!args.embedding) return null;

  const duplicateThreshold = args.duplicateThreshold ?? 0.95;
  const updateThreshold = args.updateThreshold ?? 0.75;
  const embeddingLiteral = `[${args.embedding.join(',')}]`;
  const topMatch = await findTopSimilarEntry({
    memoryId: args.memoryId,
    embeddingLiteral,
  });
  if (!topMatch) return null;

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
      tags: args.tags,
      metadata: args.metadata,
      consolidation: args.consolidation,
    });
    return { action: 'updated', entry };
  }

  return null;
};

export const writeMemoryEntry = async (args: {
  memoryId: number;
  content: string;
  sourceType?: MemoryEntrySource;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
  duplicateThreshold?: number;
  updateThreshold?: number;
  consolidation?: MemoryConsolidationContext;
}): Promise<WriteMemoryEntryResult> => {
  // Step 1: Generate embedding for incoming content
  let embedding: number[] | null = null;
  try {
    embedding = await getEmbedding({ text: args.content });
  } catch {
    // embedding is optional
  }

  // Step 2 & 3: dedup/merge against the most similar existing entry
  const deduped = await resolveDedupAction({ ...args, embedding });
  if (deduped) return deduped;

  // Step 3c: New — create
  const entry = await db.MemoryEntry.create({
    memoryId: args.memoryId,
    content: args.content,
    sourceType: args.sourceType ?? 'manual',
    tags: args.tags ?? null,
    metadata: args.metadata ?? null,
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
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
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
    tags: args.tags ?? null,
    metadata: args.metadata ?? null,
    embedding,
  });

  const withMemory = await db.MemoryEntry.findOne({
    where: { id: entry.id },
    include: [{ model: db.Memory, as: 'memory' }],
  });

  return mapMemoryEntry(withMemory!);
};

export const listMemoryEntries = async (args: {
  memoryId: number;
  limit?: number;
  offset?: number;
}) => {
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.MemoryEntry.findAndCountAll({
        where: { memoryId: args.memoryId },
        include: [{ model: db.Memory, as: 'memory' }],
        order: [['createdAt', 'ASC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapMemoryEntry,
  });
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
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
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

  if (args.tags !== undefined) {
    entry.tags = args.tags;
  }

  if (args.metadata !== undefined) {
    entry.metadata = args.metadata;
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
