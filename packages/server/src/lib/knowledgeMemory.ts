import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { getEmbedding } from './embedding';

export type MemoryQueryConfig = {
  memoryIds?: string[];
  memoryTags?: string[];
  search?: string;
  minScore?: number;
  limit?: number;
};

export type MemoryKnowledgeResult = {
  sourceType: 'memory';
  entryId: string;
  memoryId: string;
  memoryName: string;
  content: string;
  similarityScore?: number;
  createdAt: Date;
  updatedAt: Date;
};

const resolveMemoryIdsByGlobTags = async (args: {
  tags: string[];
  projectIds?: number[];
}): Promise<string[]> => {
  const sequelize = db.Memory.sequelize!;
  const patterns = args.tags.map((tag) => {
    return tag.replace(/\*/g, '%').replace(/\?/g, '_');
  });
  const likeConditions = patterns
    .map((p) => {
      return `tag ILIKE ${sequelize.escape(p)}`;
    })
    .join(' OR ');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {
    [Op.and]: sequelize.literal(
      `EXISTS (SELECT 1 FROM unnest("Memory"."tags") AS t(tag) WHERE ${likeConditions})`
    ),
  };
  if (args.projectIds && args.projectIds.length > 0) {
    where.projectId = args.projectIds;
  }
  const memories = await db.Memory.findAll({
    where,
    attributes: ['publicId'],
  });
  return memories.map((m) => {
    return m.publicId;
  });
};

const buildMemoryIncludeWhere = (args: {
  memoryIds: string[];
  projectIds?: number[];
}): { where: Record<string, unknown>; hasFilters: boolean } => {
  const { memoryIds, projectIds } = args;
  if (memoryIds.length === 0) return { where: {}, hasFilters: false };
  const where: Record<string, unknown> = { publicId: memoryIds };
  if (projectIds && projectIds.length > 0) where['projectId'] = projectIds;
  return { where, hasFilters: true };
};

const resolveMemorySearchBySemantic = async (args: {
  memoryIncludeWhere: Record<string, unknown>;
  search: string;
  limit: number;
  minScore?: number;
}): Promise<MemoryKnowledgeResult[]> => {
  const embedding = await getEmbedding({ text: args.search });
  const embeddingLiteral = `[${embedding.join(',')}]`;
  const distanceLiteral = db.MemoryEntry.sequelize!.literal(
    `embedding <=> '${embeddingLiteral}'`
  );
  const entries = await db.MemoryEntry.findAll({
    attributes: { include: [[distanceLiteral, 'distance']] },
    include: [
      {
        model: db.Memory,
        as: 'memory',
        where: args.memoryIncludeWhere,
        required: true,
      },
    ],
    order: distanceLiteral,
    subQuery: false,
    limit: args.limit,
  });
  const results = entries.map((entry) => {
    const distance = parseFloat(
      (entry.getDataValue('distance') as string) ?? '1'
    );
    const memory = entry.memory as InstanceType<typeof db.Memory>;
    return {
      sourceType: 'memory' as const,
      entryId: entry.publicId,
      memoryId: memory.publicId,
      memoryName: memory.name,
      content: entry.content,
      similarityScore: 1 - distance,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  });
  if (args.minScore === undefined) return results;
  const { minScore } = args;
  return results.filter((r) => {
    return (r.similarityScore ?? 0) >= minScore;
  });
};

export const resolveMemorySearch = async (args: {
  projectIds?: number[];
  config: MemoryQueryConfig;
}): Promise<MemoryKnowledgeResult[]> => {
  const { config, projectIds } = args;
  const hasOriginalMemoryIds =
    Array.isArray(config.memoryIds) && config.memoryIds.length > 0;
  const hasMemoryTags =
    Array.isArray(config.memoryTags) && config.memoryTags.length > 0;

  if (!hasOriginalMemoryIds && !hasMemoryTags) return [];

  let effectiveMemoryIds = [...(config.memoryIds ?? [])];
  if (hasMemoryTags) {
    const tagMatchedIds = await resolveMemoryIdsByGlobTags({
      tags: config.memoryTags!,
      projectIds,
    });
    effectiveMemoryIds = [
      ...new Set([...effectiveMemoryIds, ...tagMatchedIds]),
    ];
  }

  if (effectiveMemoryIds.length === 0) return [];

  const { where: memoryIncludeWhere } = buildMemoryIncludeWhere({
    memoryIds: effectiveMemoryIds,
    projectIds,
  });

  const limit = config.limit ?? 10;

  if (config.search) {
    return resolveMemorySearchBySemantic({
      memoryIncludeWhere,
      search: config.search,
      limit,
      minScore: config.minScore,
    });
  }

  const entries = await db.MemoryEntry.findAll({
    include: [
      {
        model: db.Memory,
        as: 'memory',
        where: memoryIncludeWhere,
        required: true,
      },
    ],
    order: [['createdAt', 'ASC']],
    limit,
  });

  return entries.map((entry) => {
    const memory = entry.memory as InstanceType<typeof db.Memory>;
    return {
      sourceType: 'memory' as const,
      entryId: entry.publicId,
      memoryId: memory.publicId,
      memoryName: memory.name,
      content: entry.content,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  });
};
