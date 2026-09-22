import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import type { EmbeddingBillingProjectId } from './embedding';
import { distanceExpression, embedQueryOrDegrade } from './knowledgeEmbedding';
import {
  lexicalMatchWhere,
  lexicalRankExpression,
  withLexicalDegrade,
} from './knowledgeLexical';
import type {
  SearchCandidates,
  SearchSignals,
  SignalCandidate,
} from './knowledgeRanking';
import { fuseCandidates } from './knowledgeRanking';
import { validMemoryWhere } from './memoryValidity';
import { hasPolicyConstraints } from './policyWhere';
import { clampKnowledgeSearchLimit } from './requestBounds';
import { hasTagFilter, tagContainment } from './tags';
import { withIterativeVectorScan } from './vectorSearch';

export type MemoryStoreQueryConfig = {
  memoryStoreIds?: string[];
  tags?: Record<string, string>;
  search?: string;
  /** Cosine floor on the **vector** candidates only. */
  minSimilarity?: number;
  rrfK?: number;
  /** Half-life in days of the recency decay; `0` disables it. */
  recencyHalfLifeDays?: number;
  limit?: number;
};

export type MemoryKnowledgeResult = {
  source_type: 'memory';
  memory_id: string;
  memory_store_id: string;
  memory_store_name: string;
  content: string;
  tags: Record<string, string> | null;
  /**
   * Fused relevance ranking — higher is better. The ordering it produces is the
   * contract; the absolute value is not, and the formula behind it may change.
   * `similarity_score` stays pinned to raw cosine.
   */
  score?: number;
  /** Which channels ranked this memory, and where. See {@link SearchSignals}. */
  signals?: SearchSignals;
  similarity_score?: number;
  created_at: Date;
  updated_at: Date;
};

const resolveMemoryStoreIdsByTags = async (args: {
  tags: Record<string, string>;
  projectIds?: number[];
}): Promise<string[]> => {
  const where: Record<string, unknown> = { ...tagContainment(args.tags) };
  if (args.projectIds && args.projectIds.length > 0) {
    where.projectId = args.projectIds;
  }
  const memoryStores = await db.MemoryStore.findAll({
    where,
    attributes: ['publicId'],
  });
  return memoryStores.map((m) => {
    return m.publicId;
  });
};

/**
 * Resolves the given memory store public ids to internal ids, scoped to the project
 * set when provided. Used to filter memories on their native `memoryStoreId`
 * foreign key (no cross-table reference needed in the entry query).
 */
const resolveMemoryStoreInternalIds = async (args: {
  publicIds: string[];
  projectIds?: number[];
}): Promise<number[]> => {
  if (args.publicIds.length === 0) return [];
  const where: Record<string, unknown> = { publicId: args.publicIds };
  if (args.projectIds && args.projectIds.length > 0) {
    where.projectId = args.projectIds;
  }
  const memoryStores = await db.MemoryStore.findAll({
    where,
    attributes: ['id'],
  });
  return memoryStores.map((m) => {
    return m.id as number;
  });
};

/** `score` is left to the fusion step, the only place that knows it. */
const mapEntry = (
  entry: MemoryWithStore,
  similarityScore?: number
): MemoryKnowledgeResult => {
  const memoryStore = entry.memoryStore;
  return {
    source_type: 'memory' as const,
    memory_id: entry.publicId,
    memory_store_id: memoryStore.publicId,
    memory_store_name: memoryStore.name,
    content: entry.content.content,
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
  NonNullable<Parameters<typeof db.Memory.findAll>[0]>['where']
>;

// Both columns live on the joined `memory_contents` row, not on the memory: a
// memory keeps identity and validity, its content row keeps the text and the
// vector. The alias is the include's `as`, and qualifying is not optional —
// `memories` joins itself elsewhere in these queries.
const ENTRY_CONTENT_COLUMN = '"content"."content"';
const ENTRY_EMBEDDING_COLUMN = '"content"."embedding"';

type MemoryWithStore = InstanceType<typeof db.Memory> & {
  memoryStore: InstanceType<typeof db.MemoryStore>;
  content: InstanceType<typeof db.MemoryContent>;
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

/**
 * The store (scoped by the caller's policy) and the shared content row every
 * result reads its text and vector from. `required` on both: a memory always
 * has a content row, and one that somehow did not could not be ranked or
 * rendered anyway.
 */
const memoryStoreInclude = (args: {
  memoryStoreWhere: Record<string, unknown>;
}) => {
  return [
    {
      model: db.MemoryStore,
      as: 'memoryStore',
      where: args.memoryStoreWhere,
      required: true,
    },
    {
      model: db.MemoryContent,
      as: 'content',
      required: true,
    },
  ];
};

const readEntrySimilarity = (entry: MemoryWithStore): number | undefined => {
  const distance = entry.getDataValue('distance') as string | undefined;
  if (distance === undefined || distance === null) return undefined;
  return 1 - parseFloat(distance);
};

const toEntryResult = (entry: MemoryWithStore): MemoryKnowledgeResult => {
  return mapEntry(entry, readEntrySimilarity(entry));
};

const toVectorCandidate = (
  entry: MemoryWithStore
): SignalCandidate<MemoryKnowledgeResult> => {
  return {
    item: toEntryResult(entry),
    signal: readEntrySimilarity(entry) ?? 0,
  };
};

const toLexicalCandidate = (
  entry: MemoryWithStore
): SignalCandidate<MemoryKnowledgeResult> => {
  return {
    item: toEntryResult(entry),
    signal: parseFloat(
      (entry.getDataValue('lexicalRank') as string | undefined) ?? '0'
    ),
  };
};

/**
 * The vector channel's candidate list. `embedding IS NOT NULL` on the shared
 * content row is what keeps it one: a NULL embedding yields a NULL distance,
 * which sorts last rather than being excluded, so an unembedded entry is
 * otherwise ranked as a vector hit whenever the scope holds fewer embedded
 * entries than `limit`. The column is reachable from the top-level `where`
 * because this query joins in the main statement (`subQuery: false`).
 */
const findEntriesByVector = async (args: {
  entryWhere: Record<string, unknown>;
  memoryStoreWhere: Record<string, unknown>;
  distanceLiteral: Literal;
  limit: number;
}): Promise<MemoryWithStore[]> => {
  const entries = await withIterativeVectorScan({
    run: ({ transaction }) => {
      return db.Memory.findAll({
        where: { ...args.entryWhere, '$content.embedding$': { [Op.ne]: null } },
        attributes: entryAttributes({ distanceLiteral: args.distanceLiteral }),
        include: memoryStoreInclude({
          memoryStoreWhere: args.memoryStoreWhere,
        }),
        order: args.distanceLiteral,
        subQuery: false,
        limit: args.limit,
        transaction,
      });
    },
  });
  return entries as MemoryWithStore[];
};

/**
 * The same entry scope — container or per-entry tags, `invalidated_at IS NULL`,
 * and the caller's compiled policy on both the entry and its memory store — ranked by
 * `ts_rank_cd` instead of cosine distance.
 */
const findEntriesByLexical = async (args: {
  entryWhere: Record<string, unknown>;
  memoryStoreWhere: Record<string, unknown>;
  distanceLiteral?: Literal;
  search: string;
  limit: number;
}): Promise<MemoryWithStore[]> => {
  const lexicalMatch = lexicalMatchWhere({
    column: ENTRY_CONTENT_COLUMN,
    query: args.search,
  });
  const lexicalRank = lexicalRankExpression({
    column: ENTRY_CONTENT_COLUMN,
    query: args.search,
  });

  const entries = await withLexicalDegrade({
    source: 'memories',
    run: () => {
      return db.Memory.findAll({
        where: {
          [Op.and]: [args.entryWhere, lexicalMatch],
        } as EntryWhere,
        attributes: entryAttributes({
          distanceLiteral: args.distanceLiteral,
          lexicalRank,
        }),
        include: memoryStoreInclude({
          memoryStoreWhere: args.memoryStoreWhere,
        }),
        order: [[lexicalRank, 'DESC']],
        subQuery: false,
        limit: args.limit,
      });
    },
  });
  return entries as MemoryWithStore[];
};

/** The memory half's ranked candidate lists: vector first, lexical second. */
const findEntriesWithSearch = async (args: {
  entryWhere: Record<string, unknown>;
  memoryStoreWhere: Record<string, unknown>;
  /** The query vector, or `undefined` where the search degraded to lexical. */
  embedding: number[] | undefined;
  search: string;
  limit: number;
  minSimilarity?: number;
}): Promise<SearchCandidates<MemoryKnowledgeResult>> => {
  const { embedding } = args;
  const distanceLiteral = embedding
    ? db.Memory.sequelize!.literal(
        distanceExpression({ column: ENTRY_EMBEDDING_COLUMN, embedding })
      )
    : undefined;

  const [vector, lexical] = await Promise.all([
    distanceLiteral
      ? findEntriesByVector({
          entryWhere: args.entryWhere,
          memoryStoreWhere: args.memoryStoreWhere,
          distanceLiteral,
          limit: args.limit,
        })
      : Promise.resolve([]),
    findEntriesByLexical({
      entryWhere: args.entryWhere,
      memoryStoreWhere: args.memoryStoreWhere,
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
 * matched memory store container or carry matching per-entry tags. Returns null when
 * no selection applies (so the caller returns an empty result set).
 */
const buildEntrySelection = async (args: {
  config: MemoryStoreQueryConfig;
  projectIds?: number[];
}): Promise<Record<string, unknown> | null> => {
  const { config, projectIds } = args;
  const hasTags = hasTagFilter(config.tags);

  // Container-level tag matching: memory stores whose own tags contain the pairs,
  // unioned with any explicitly requested memory store ids. Entries in these
  // containers are returned regardless of their own per-entry tags.
  const effectiveMemoryStoreIds = [...(config.memoryStoreIds ?? [])];
  if (hasTags) {
    const tagMatchedIds = await resolveMemoryStoreIdsByTags({
      tags: config.tags!,
      projectIds,
    });
    effectiveMemoryStoreIds.push(...tagMatchedIds);
  }
  const memoryStoreInternalIds = await resolveMemoryStoreInternalIds({
    publicIds: [...new Set(effectiveMemoryStoreIds)],
    projectIds,
  });

  // A union of two independent matches — the entry's container, or the entry's
  // own tags. Both are expressed against the entry table, so no cross-table
  // reference is needed.
  const selectionClauses: unknown[] = [];
  if (memoryStoreInternalIds.length > 0) {
    selectionClauses.push({ memoryStoreId: memoryStoreInternalIds });
  }
  if (hasTags) {
    selectionClauses.push(tagContainment(config.tags!));
  }

  if (selectionClauses.length === 0) {
    // Two different nothings. A request that *named* containers and resolved
    // none of them selects nothing: the ids are absent, in another project, or
    // unreadable, and widening to the whole project would answer a question
    // nobody asked. A request that named none selects every memory the caller
    // can see — `memoryStoreWhere` already bounds that by project and policy.
    const namedContainers =
      Array.isArray(config.memoryStoreIds) && config.memoryStoreIds.length > 0;
    return namedContainers ? null : {};
  }

  if (selectionClauses.length === 1) {
    return selectionClauses[0] as Record<string, unknown>;
  }
  // `Op.or` is a symbol key, which a plain `Record<string, unknown>` type can't
  // express — the same Sequelize quirk `resolveMemoryStoreIdsByGlobTags` handles for
  // `Op.and` above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orWhere: any = { [Op.or]: selectionClauses };
  return orWhere;
};

/**
 * The caller's compiled policy, split by the model each clause names. The
 * container clause filters the `MemoryStore` join and the entry clause the entry
 * rows, so an entry is returned only when both its memory store and itself are
 * permitted — the same rule the entry routes enforce.
 */
export type MemoryStorePolicyWhere = {
  memoryStore?: Record<string, unknown>;
  memory?: Record<string, unknown>;
};

/**
 * The two WHERE clauses a memory store search runs with: one on the entry rows it
 * ranks, one on the `MemoryStore` join. Each policy clause goes to the model whose
 * columns it names — an entry clause on the join, or the reverse, would filter
 * the wrong table or name a column that is not there.
 */
const buildSearchWheres = (args: {
  selection: Record<string, unknown>;
  projectIds?: number[];
  policyWhere?: MemoryStorePolicyWhere;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): { entryWhere: any; memoryStoreWhere: Record<string, unknown> } => {
  // A superseded entry stays readable through the entries API for audit, but
  // must never be injected into a generation as though it still held. `Op.and`
  // composes with the selection's own `Op.or` without flattening it.
  const entryWhere = {
    [Op.and]: [
      args.selection,
      validMemoryWhere(),
      ...(hasPolicyConstraints(args.policyWhere?.memory)
        ? [args.policyWhere.memory]
        : []),
    ],
  };

  const memoryStoreWhere: Record<string, unknown> = {};
  if (args.projectIds && args.projectIds.length > 0) {
    memoryStoreWhere.projectId = args.projectIds;
  }
  if (hasPolicyConstraints(args.policyWhere?.memoryStore)) {
    Object.assign(memoryStoreWhere, args.policyWhere.memoryStore);
  }

  return { entryWhere, memoryStoreWhere };
};

/**
 * The memory store's shard of each signal, when `config.search` is set; the
 * deterministic oldest-first read, which no signal ranks, when it is not.
 */
export const resolveMemoryStoreSearchLists = async (args: {
  projectIds?: number[];
  /** See `resolveDocumentSearchLists` in `knowledgeDocuments.ts`. */
  embedding: number[] | undefined;
  config: MemoryStoreQueryConfig;
  policyWhere?: MemoryStorePolicyWhere;
}): Promise<SearchCandidates<MemoryKnowledgeResult>> => {
  const { config, projectIds } = args;
  const empty: SearchCandidates<MemoryKnowledgeResult> = config.search
    ? { ranked: true, vector: [], lexical: [] }
    : { ranked: false, results: [] };

  // Whether this store is read at all is `searchKnowledge`'s decision, not
  // this function's: a request naming neither a container nor a tag reaches
  // every memory the caller can see rather than being refused here.
  const selection = await buildEntrySelection({ config, projectIds });
  if (!selection) return empty;

  const { entryWhere, memoryStoreWhere } = buildSearchWheres({
    selection,
    projectIds,
    policyWhere: args.policyWhere,
  });

  const limit = clampKnowledgeSearchLimit(config.limit);

  if (config.search) {
    return findEntriesWithSearch({
      entryWhere,
      memoryStoreWhere,
      embedding: args.embedding,
      search: config.search,
      limit,
      minSimilarity: config.minSimilarity,
    });
  }

  const entries = await db.Memory.findAll({
    where: entryWhere,
    include: memoryStoreInclude({ memoryStoreWhere }),
    order: [['createdAt', 'ASC']],
    subQuery: false,
    limit,
  });

  return {
    ranked: false,
    results: entries.map((entry) => {
      return mapEntry(entry as MemoryWithStore);
    }),
  };
};

/**
 * Ranks memories alone. `searchKnowledge` is the path that reads both
 * stores; this one fuses the two signals over a single store's shard of each.
 */
export const resolveMemoryStoreSearch = async (args: {
  projectIds?: number[];
  billingProjectId: EmbeddingBillingProjectId;
  config: MemoryStoreQueryConfig;
  policyWhere?: MemoryStorePolicyWhere;
}): Promise<MemoryKnowledgeResult[]> => {
  const candidates = await resolveMemoryStoreSearchLists({
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
      return result.memory_id;
    },
    rrfK: args.config.rrfK,
    // Every result of this entry point is a memory.
    isMemory: () => {
      return true;
    },
    recencyHalfLifeDays: args.config.recencyHalfLifeDays,
    limit: clampKnowledgeSearchLimit(args.config.limit),
  });
};
