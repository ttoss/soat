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
  tags: string[] | null;
  similarityScore?: number;
  createdAt: Date;
  updatedAt: Date;
};

const globToLikePattern = (tag: string): string => {
  return tag.replace(/\*/g, '%').replace(/\?/g, '_');
};

/**
 * Builds an `EXISTS (SELECT 1 FROM unnest(<column>) …)` fragment that matches
 * when any element of a text[] column matches one of the glob tag patterns.
 */
const buildTagExistsLiteral = (args: { column: string; tags: string[] }) => {
  const sequelize = db.Memory.sequelize!;
  const likeConditions = args.tags
    .map((tag) => {
      return `tag ILIKE ${sequelize.escape(globToLikePattern(tag))}`;
    })
    .join(' OR ');
  return sequelize.literal(
    `EXISTS (SELECT 1 FROM unnest(${args.column}) AS t(tag) WHERE ${likeConditions})`
  );
};

const resolveMemoryIdsByGlobTags = async (args: {
  tags: string[];
  projectIds?: number[];
}): Promise<string[]> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {
    [Op.and]: buildTagExistsLiteral({
      column: '"Memory"."tags"',
      tags: args.tags,
    }),
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

/**
 * Resolves the given memory public ids to internal ids, scoped to the project
 * set when provided. Used to filter memory entries on their native `memoryId`
 * foreign key (no cross-table reference needed in the entry query).
 */
const resolveMemoryInternalIds = async (args: {
  publicIds: string[];
  projectIds?: number[];
}): Promise<number[]> => {
  if (args.publicIds.length === 0) return [];
  const where: Record<string, unknown> = { publicId: args.publicIds };
  if (args.projectIds && args.projectIds.length > 0) {
    where.projectId = args.projectIds;
  }
  const memories = await db.Memory.findAll({ where, attributes: ['id'] });
  return memories.map((m) => {
    return m.id as number;
  });
};

const mapEntry = (
  entry: InstanceType<typeof db.MemoryEntry> & {
    memory: InstanceType<typeof db.Memory>;
  },
  similarityScore?: number
): MemoryKnowledgeResult => {
  const memory = entry.memory;
  return {
    sourceType: 'memory' as const,
    entryId: entry.publicId,
    memoryId: memory.publicId,
    memoryName: memory.name,
    content: entry.content,
    tags: entry.tags ?? null,
    ...(similarityScore === undefined ? {} : { similarityScore }),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
};

const resolveMemorySearchBySemantic = async (args: {
  entryWhere: Record<string, unknown>;
  memoryWhere: Record<string, unknown>;
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
    where: args.entryWhere,
    attributes: { include: [[distanceLiteral, 'distance']] },
    include: [
      {
        model: db.Memory,
        as: 'memory',
        where: args.memoryWhere,
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
    return mapEntry(
      entry as InstanceType<typeof db.MemoryEntry> & {
        memory: InstanceType<typeof db.Memory>;
      },
      1 - distance
    );
  });
  if (args.minScore === undefined) return results;
  const { minScore } = args;
  return results.filter((r) => {
    return (r.similarityScore ?? 0) >= minScore;
  });
};

/**
 * Builds the entry-level WHERE clause selecting entries that either belong to a
 * matched memory container or carry matching per-entry tags. Returns null when
 * no selection applies (so the caller returns an empty result set).
 */
const buildEntrySelection = async (args: {
  config: MemoryQueryConfig;
  projectIds?: number[];
}): Promise<Record<string, unknown> | null> => {
  const { config, projectIds } = args;
  const hasMemoryTags =
    Array.isArray(config.memoryTags) && config.memoryTags.length > 0;

  // Container-level tag matching: memories whose own tags match the globs,
  // unioned with any explicitly requested memory ids. Entries in these
  // containers are returned regardless of their own per-entry tags.
  const effectiveMemoryIds = [...(config.memoryIds ?? [])];
  if (hasMemoryTags) {
    const tagMatchedIds = await resolveMemoryIdsByGlobTags({
      tags: config.memoryTags!,
      projectIds,
    });
    effectiveMemoryIds.push(...tagMatchedIds);
  }
  const memoryInternalIds = await resolveMemoryInternalIds({
    publicIds: [...new Set(effectiveMemoryIds)],
    projectIds,
  });

  // Selection is a union of two independent matches:
  //   1. the entry belongs to a selected memory container, OR
  //   2. the entry's own tags match the globs (entry-granularity filtering).
  // Both are expressed against the entry table (the container match uses the
  // native `memoryId` FK), so no cross-table reference is needed here.
  const selectionClauses: unknown[] = [];
  if (memoryInternalIds.length > 0) {
    selectionClauses.push({ memoryId: memoryInternalIds });
  }
  if (hasMemoryTags) {
    selectionClauses.push(
      buildTagExistsLiteral({
        column: '"MemoryEntry"."tags"',
        tags: config.memoryTags!,
      })
    );
  }

  if (selectionClauses.length === 0) return null;

  if (selectionClauses.length === 1) {
    return selectionClauses[0] as Record<string, unknown>;
  }
  // `Op.or` is a symbol key, which a plain `Record<string, unknown>` type can't
  // express — the same Sequelize quirk `resolveMemoryIdsByGlobTags` handles for
  // `Op.and` above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orWhere: any = { [Op.or]: selectionClauses };
  return orWhere;
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

  const entryWhere = await buildEntrySelection({ config, projectIds });
  if (!entryWhere) return [];

  const memoryWhere: Record<string, unknown> = {};
  if (projectIds && projectIds.length > 0) memoryWhere.projectId = projectIds;

  const limit = config.limit ?? 10;

  if (config.search) {
    return resolveMemorySearchBySemantic({
      entryWhere,
      memoryWhere,
      search: config.search,
      limit,
      minScore: config.minScore,
    });
  }

  const entries = await db.MemoryEntry.findAll({
    where: entryWhere,
    include: [
      {
        model: db.Memory,
        as: 'memory',
        where: memoryWhere,
        required: true,
      },
    ],
    order: [['createdAt', 'ASC']],
    subQuery: false,
    limit,
  });

  return entries.map((entry) => {
    return mapEntry(
      entry as InstanceType<typeof db.MemoryEntry> & {
        memory: InstanceType<typeof db.Memory>;
      }
    );
  });
};
