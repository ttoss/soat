import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import type { EmbeddingBillingProjectId } from './embedding';
import { getEmbedding } from './embedding';
import { clampKnowledgeSearchLimit } from './requestBounds';
import { hasTagFilter } from './tags';
import { withIterativeVectorScan } from './vectorSearch';

export type MemoryQueryConfig = {
  memoryIds?: string[];
  tags?: Record<string, string>;
  search?: string;
  minScore?: number;
  limit?: number;
};

export type MemoryKnowledgeResult = {
  source_type: 'memory';
  entry_id: string;
  memory_id: string;
  memory_name: string;
  content: string;
  tags: Record<string, string> | null;
  /**
   * Implementation-defined relevance ranking — higher is better. The ordering
   * it produces is the contract; the absolute value is not, and the formula
   * behind it may change. `similarity_score` stays pinned to raw cosine.
   */
  score?: number;
  similarity_score?: number;
  created_at: Date;
  updated_at: Date;
};

/**
 * JSONB containment: every requested pair must be present with exactly that
 * value. One rule for both stores and for IAM `soat:ResourceTag/<key>`, which
 * reads the same column shape.
 */
const tagContainment = (tags: Record<string, string>) => {
  return { [Op.contains]: tags };
};

const resolveMemoryIdsByTags = async (args: {
  tags: Record<string, string>;
  projectIds?: number[];
}): Promise<string[]> => {
  const where: Record<string, unknown> = { tags: tagContainment(args.tags) };
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
    source_type: 'memory' as const,
    entry_id: entry.publicId,
    memory_id: memory.publicId,
    memory_name: memory.name,
    content: entry.content,
    tags: entry.tags ?? null,
    // Single-signal ranking today, so `score` is the cosine value. Both fields
    // are absent without a query, where there is no ranking signal at all.
    ...(similarityScore === undefined
      ? {}
      : { score: similarityScore, similarity_score: similarityScore }),
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
};

const resolveMemorySearchBySemantic = async (args: {
  entryWhere: Record<string, unknown>;
  memoryWhere: Record<string, unknown>;
  billingProjectId: EmbeddingBillingProjectId;
  search: string;
  limit: number;
  minScore?: number;
}): Promise<MemoryKnowledgeResult[]> => {
  const embedding = await getEmbedding({
    text: args.search,
    projectId: args.billingProjectId,
  });
  const embeddingLiteral = `[${embedding.join(',')}]`;
  const distanceLiteral = db.MemoryEntry.sequelize!.literal(
    `embedding <=> '${embeddingLiteral}'`
  );
  const entries = await withIterativeVectorScan({
    run: ({ transaction }) => {
      return db.MemoryEntry.findAll({
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
        transaction,
      });
    },
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
    // Filters on `score`, the documented ranking, so a future change to how
    // `score` is computed carries `min_score` with it automatically.
    return (r.score ?? 0) >= minScore;
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
  const hasTags = hasTagFilter(config.tags);

  // Container-level tag matching: memories whose own tags contain the pairs,
  // unioned with any explicitly requested memory ids. Entries in these
  // containers are returned regardless of their own per-entry tags.
  const effectiveMemoryIds = [...(config.memoryIds ?? [])];
  if (hasTags) {
    const tagMatchedIds = await resolveMemoryIdsByTags({
      tags: config.tags!,
      projectIds,
    });
    effectiveMemoryIds.push(...tagMatchedIds);
  }
  const memoryInternalIds = await resolveMemoryInternalIds({
    publicIds: [...new Set(effectiveMemoryIds)],
    projectIds,
  });

  // A union of two independent matches — the entry's container, or the entry's
  // own tags. Both are expressed against the entry table, so no cross-table
  // reference is needed.
  const selectionClauses: unknown[] = [];
  if (memoryInternalIds.length > 0) {
    selectionClauses.push({ memoryId: memoryInternalIds });
  }
  if (hasTags) {
    selectionClauses.push({ tags: tagContainment(config.tags!) });
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
  /** See `resolveDocumentSearch` in `knowledge.ts`. */
  billingProjectId: EmbeddingBillingProjectId;
  config: MemoryQueryConfig;
}): Promise<MemoryKnowledgeResult[]> => {
  const { config, projectIds } = args;
  const hasOriginalMemoryIds =
    Array.isArray(config.memoryIds) && config.memoryIds.length > 0;

  if (!hasOriginalMemoryIds && !hasTagFilter(config.tags)) return [];

  const selection = await buildEntrySelection({ config, projectIds });
  if (!selection) return [];

  // A superseded entry stays readable through the entries API for audit, but
  // must never be injected into a generation as though it still held. `Op.and`
  // composes with the selection's own `Op.or` without flattening it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entryWhere: any = {
    [Op.and]: [selection, { invalidatedAt: null }],
  };

  const memoryWhere: Record<string, unknown> = {};
  if (projectIds && projectIds.length > 0) memoryWhere.projectId = projectIds;

  const limit = clampKnowledgeSearchLimit(config.limit);

  if (config.search) {
    return resolveMemorySearchBySemantic({
      entryWhere,
      memoryWhere,
      billingProjectId: args.billingProjectId,
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
