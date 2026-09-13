import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import type { EmbeddingBillingProjectId } from './embedding';
import { distanceExpression, embedQueryOrDegrade } from './knowledgeEmbedding';
import {
  lexicalMatchWhere,
  lexicalRankExpression,
  withLexicalDegrade,
} from './knowledgeLexical';
import type { SearchCandidates, SignalCandidate } from './knowledgeRanking';
import { fuseCandidates } from './knowledgeRanking';
import { hasPolicyConstraints } from './policyWhere';
import { clampKnowledgeSearchLimit } from './requestBounds';
import { hasTagFilter, tagContainment } from './tags';
import { withIterativeVectorScan } from './vectorSearch';

export type MemoryQueryConfig = {
  memoryIds?: string[];
  tags?: Record<string, string>;
  search?: string;
  /** Cosine floor on the **vector** candidates only. */
  minSimilarity?: number;
  rrfK?: number;
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
   * Fused relevance ranking — higher is better. The ordering it produces is the
   * contract; the absolute value is not, and the formula behind it may change.
   * `similarity_score` stays pinned to raw cosine.
   */
  score?: number;
  similarity_score?: number;
  created_at: Date;
  updated_at: Date;
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

/** `score` is left to the fusion step, the only place that knows it. */
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
    ...(similarityScore === undefined
      ? {}
      : { similarity_score: similarityScore }),
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
};

/** Sequelize fragment types `@ttoss/postgresdb` does not re-export. */
type Literal = ReturnType<typeof db.sequelize.literal>;
type EntryWhere = NonNullable<
  NonNullable<Parameters<typeof db.MemoryEntry.findAll>[0]>['where']
>;

const ENTRY_CONTENT_COLUMN = '"MemoryEntry"."content"';
const ENTRY_EMBEDDING_COLUMN = 'embedding';

type EntryWithMemory = InstanceType<typeof db.MemoryEntry> & {
  memory: InstanceType<typeof db.Memory>;
};

const entryAttributes = (args: {
  distanceLiteral?: Literal;
  lexicalRank?: ReturnType<typeof lexicalRankExpression>;
}) => {
  const include = [
    ...(args.distanceLiteral
      ? [[args.distanceLiteral, 'distance'] as const]
      : []),
    ...(args.lexicalRank ? [[args.lexicalRank, 'lexicalRank'] as const] : []),
  ];
  return include.length > 0 ? { include } : undefined;
};

const memoryInclude = (args: { memoryWhere: Record<string, unknown> }) => {
  return [
    {
      model: db.Memory,
      as: 'memory',
      where: args.memoryWhere,
      required: true,
    },
  ];
};

const readEntrySimilarity = (entry: EntryWithMemory): number | undefined => {
  const distance = entry.getDataValue('distance') as string | undefined;
  if (distance === undefined || distance === null) return undefined;
  return 1 - parseFloat(distance);
};

const toEntryResult = (entry: EntryWithMemory): MemoryKnowledgeResult => {
  return mapEntry(entry, readEntrySimilarity(entry));
};

const toVectorCandidate = (
  entry: EntryWithMemory
): SignalCandidate<MemoryKnowledgeResult> => {
  return {
    item: toEntryResult(entry),
    signal: readEntrySimilarity(entry) ?? 0,
  };
};

const toLexicalCandidate = (
  entry: EntryWithMemory
): SignalCandidate<MemoryKnowledgeResult> => {
  return {
    item: toEntryResult(entry),
    signal: parseFloat(
      (entry.getDataValue('lexicalRank') as string | undefined) ?? '0'
    ),
  };
};

const findEntriesByVector = async (args: {
  entryWhere: Record<string, unknown>;
  memoryWhere: Record<string, unknown>;
  distanceLiteral: Literal;
  limit: number;
}): Promise<EntryWithMemory[]> => {
  const entries = await withIterativeVectorScan({
    run: ({ transaction }) => {
      return db.MemoryEntry.findAll({
        where: args.entryWhere,
        attributes: entryAttributes({ distanceLiteral: args.distanceLiteral }),
        include: memoryInclude({ memoryWhere: args.memoryWhere }),
        order: args.distanceLiteral,
        subQuery: false,
        limit: args.limit,
        transaction,
      });
    },
  });
  return entries as EntryWithMemory[];
};

/**
 * The same entry scope — container or per-entry tags, `invalidated_at IS NULL`,
 * and the caller's compiled policy on both the entry and its memory — ranked by
 * `ts_rank_cd` instead of cosine distance.
 */
const findEntriesByLexical = async (args: {
  entryWhere: Record<string, unknown>;
  memoryWhere: Record<string, unknown>;
  distanceLiteral?: Literal;
  search: string;
  limit: number;
}): Promise<EntryWithMemory[]> => {
  const lexicalMatch = lexicalMatchWhere({
    column: ENTRY_CONTENT_COLUMN,
    query: args.search,
  });
  const lexicalRank = lexicalRankExpression({
    column: ENTRY_CONTENT_COLUMN,
    query: args.search,
  });

  const entries = await withLexicalDegrade({
    source: 'memoryEntries',
    run: () => {
      return db.MemoryEntry.findAll({
        where: {
          [Op.and]: [args.entryWhere, lexicalMatch],
        } as EntryWhere,
        attributes: entryAttributes({
          distanceLiteral: args.distanceLiteral,
          lexicalRank,
        }),
        include: memoryInclude({ memoryWhere: args.memoryWhere }),
        order: [[lexicalRank, 'DESC']],
        subQuery: false,
        limit: args.limit,
      });
    },
  });
  return entries as EntryWithMemory[];
};

/** The memory half's ranked candidate lists: vector first, lexical second. */
const findEntriesWithSearch = async (args: {
  entryWhere: Record<string, unknown>;
  memoryWhere: Record<string, unknown>;
  /** The query vector, or `undefined` where the search degraded to lexical. */
  embedding: number[] | undefined;
  search: string;
  limit: number;
  minSimilarity?: number;
}): Promise<SearchCandidates<MemoryKnowledgeResult>> => {
  const { embedding } = args;
  const distanceLiteral = embedding
    ? db.MemoryEntry.sequelize!.literal(
        distanceExpression({ column: ENTRY_EMBEDDING_COLUMN, embedding })
      )
    : undefined;

  const [vector, lexical] = await Promise.all([
    distanceLiteral
      ? findEntriesByVector({
          entryWhere: args.entryWhere,
          memoryWhere: args.memoryWhere,
          distanceLiteral,
          limit: args.limit,
        })
      : Promise.resolve([]),
    findEntriesByLexical({
      entryWhere: args.entryWhere,
      memoryWhere: args.memoryWhere,
      distanceLiteral,
      search: args.search,
      limit: args.limit,
    }),
  ]);

  const vectorCandidates = vector.map(toVectorCandidate);
  const { minSimilarity } = args;

  return {
    ranked: true,
    vector:
      minSimilarity === undefined
        ? vectorCandidates
        : vectorCandidates.filter((candidate) => {
            return candidate.signal >= minSimilarity;
          }),
    // Never floored: an entry that literally contains the searched token is the
    // evidence, whatever its cosine says.
    lexical: lexical.map(toLexicalCandidate),
  };
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

/**
 * The caller's compiled policy, split by the model each clause names. The
 * container clause filters the `memory` join and the entry clause the entry
 * rows, so an entry is returned only when both its memory and itself are
 * permitted — the same rule the entry routes enforce.
 */
export type MemoryPolicyWhere = {
  memory?: Record<string, unknown>;
  memoryEntry?: Record<string, unknown>;
};

/**
 * The two WHERE clauses a memory search runs with: one on the entry rows it
 * ranks, one on the `memory` join. Each policy clause goes to the model whose
 * columns it names — an entry clause on the join, or the reverse, would filter
 * the wrong table or name a column that is not there.
 */
const buildSearchWheres = (args: {
  selection: Record<string, unknown>;
  projectIds?: number[];
  policyWhere?: MemoryPolicyWhere;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): { entryWhere: any; memoryWhere: Record<string, unknown> } => {
  // A superseded entry stays readable through the entries API for audit, but
  // must never be injected into a generation as though it still held. `Op.and`
  // composes with the selection's own `Op.or` without flattening it.
  const entryWhere = {
    [Op.and]: [
      args.selection,
      { invalidatedAt: null },
      ...(hasPolicyConstraints(args.policyWhere?.memoryEntry)
        ? [args.policyWhere.memoryEntry]
        : []),
    ],
  };

  const memoryWhere: Record<string, unknown> = {};
  if (args.projectIds && args.projectIds.length > 0) {
    memoryWhere.projectId = args.projectIds;
  }
  if (hasPolicyConstraints(args.policyWhere?.memory)) {
    Object.assign(memoryWhere, args.policyWhere.memory);
  }

  return { entryWhere, memoryWhere };
};

/**
 * The memory store's shard of each signal, when `config.search` is set; the
 * deterministic oldest-first read, which no signal ranks, when it is not.
 */
export const resolveMemorySearchLists = async (args: {
  projectIds?: number[];
  /** See `resolveDocumentSearchLists` in `knowledgeDocuments.ts`. */
  embedding: number[] | undefined;
  config: MemoryQueryConfig;
  policyWhere?: MemoryPolicyWhere;
}): Promise<SearchCandidates<MemoryKnowledgeResult>> => {
  const { config, projectIds } = args;
  const empty: SearchCandidates<MemoryKnowledgeResult> = config.search
    ? { ranked: true, vector: [], lexical: [] }
    : { ranked: false, results: [] };
  const hasOriginalMemoryIds =
    Array.isArray(config.memoryIds) && config.memoryIds.length > 0;

  if (!hasOriginalMemoryIds && !hasTagFilter(config.tags)) return empty;

  const selection = await buildEntrySelection({ config, projectIds });
  if (!selection) return empty;

  const { entryWhere, memoryWhere } = buildSearchWheres({
    selection,
    projectIds,
    policyWhere: args.policyWhere,
  });

  const limit = clampKnowledgeSearchLimit(config.limit);

  if (config.search) {
    return findEntriesWithSearch({
      entryWhere,
      memoryWhere,
      embedding: args.embedding,
      search: config.search,
      limit,
      minSimilarity: config.minSimilarity,
    });
  }

  const entries = await db.MemoryEntry.findAll({
    where: entryWhere,
    include: memoryInclude({ memoryWhere }),
    order: [['createdAt', 'ASC']],
    subQuery: false,
    limit,
  });

  return {
    ranked: false,
    results: entries.map((entry) => {
      return mapEntry(entry as EntryWithMemory);
    }),
  };
};

/**
 * Ranks memory entries alone. `searchKnowledge` is the path that reads both
 * stores; this one fuses the two signals over a single store's shard of each.
 */
export const resolveMemorySearch = async (args: {
  projectIds?: number[];
  billingProjectId: EmbeddingBillingProjectId;
  config: MemoryQueryConfig;
  policyWhere?: MemoryPolicyWhere;
}): Promise<MemoryKnowledgeResult[]> => {
  const candidates = await resolveMemorySearchLists({
    ...args,
    embedding: args.config.search
      ? await embedQueryOrDegrade({
          text: args.config.search,
          projectId: args.billingProjectId,
        })
      : undefined,
  });
  if (!candidates.ranked) return candidates.results;

  return fuseCandidates({
    vector: [candidates.vector],
    lexical: [candidates.lexical],
    keyOf: (result) => {
      return result.entry_id;
    },
    rrfK: args.config.rrfK,
    limit: clampKnowledgeSearchLimit(args.config.limit),
  });
};
