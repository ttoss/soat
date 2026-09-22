import type { EmbeddingBillingProjectId } from './embedding';
import type { QueryDocumentResult } from './knowledgeDocuments';
import {
  DOCUMENT_METADATA_COLUMN,
  resolveDocumentSearchLists,
} from './knowledgeDocuments';
import { embedQueryOrDegrade } from './knowledgeEmbedding';
import type {
  MemoryKnowledgeResult,
  MemoryStorePolicyWhere,
} from './knowledgeMemory';
import { resolveMemoryStoreSearchLists } from './knowledgeMemory';
import type {
  SearchCandidates,
  SearchSignals,
  SignalCandidate,
} from './knowledgeRanking';
import { fuseCandidates } from './knowledgeRanking';
import { clampKnowledgeSearchLimit } from './requestBounds';
import {
  compileMetadataWhere,
  hasMetadataFilter,
  type MetadataFilter,
} from './structuredFilter';
import { hasTagFilter } from './tags';

/**
 * Unified search across the two knowledge stores. Each store's own queries live
 * beside it — `knowledgeDocuments.ts`, `knowledgeMemory.ts`; this module owns
 * only what needs both: which stores a request reaches, and the fusion that
 * puts their results in one order.
 */

export type KnowledgeResult =
  | {
      source_type: 'document';
      document_id: string;
      chunk_id: string;
      file_id?: string;
      project_id?: string;
      path?: string;
      filename?: string;
      size?: number;
      title?: string;
      metadata?: unknown;
      tags?: Record<string, string>;
      content: string | null;
      page?: number;
      /**
       * Fused relevance ranking — higher is better. The ordering it produces is
       * the contract; the absolute value is not. `similarity_score` stays
       * pinned to raw cosine.
       */
      score?: number;
      /**
       * Which channels ranked this result, and where in each channel's own
       * pre-fusion ordering. `score` is where it landed; this is how.
       */
      signals?: SearchSignals;
      similarity_score?: number;
      created_at: Date;
      updated_at: Date;
    }
  | MemoryKnowledgeResult;

type SearchKnowledgeArgs = {
  projectIds?: number[];
  /** See {@link resolveDocumentSearchLists}. Required, so a caller has to say. */
  billingProjectId: EmbeddingBillingProjectId;
  query?: string;
  /**
   * Raw-cosine floor a **vector** candidate must clear to enter fusion.
   * Lexical candidates are never subject to it.
   */
  minSimilarity?: number;
  /** The `k` in `1 / (k + rank)`. See {@link resolveRrfK}. */
  rrfK?: number;
  /**
   * Half-life in days of the recency decay applied to **memory store** results after
   * fusion. `0` — the default — disables it. See
   * {@link resolveRecencyHalfLifeDays}.
   */
  recencyHalfLifeDays?: number;
  limit?: number;
  paths?: string[];
  documentIds?: string[];
  memoryStoreIds?: string[];
  /**
   * Key-value pairs a result's own `tags` must all contain. One filter for
   * both stores: it narrows documents and memories alike, and is the
   * only filter that turns on a source on both sides at once.
   */
  tags?: Record<string, string>;
  /**
   * Structured question about a document's `metadata` bag. A document-store
   * filter: memories carry no such bag, so it names that store the way
   * `document_paths` does rather than narrowing both.
   */
  metadata?: MetadataFilter;
  /**
   * Switches the document store off even when the request would otherwise
   * reach it. Default `true`.
   *
   * Two callers use it. A request says `include_documents: false` to search
   * memories alone. Agent generation injection sets it from its own config,
   * because there `query` is derived from the chat message rather than asked
   * for: without it, a memory-scoped config would silently widen into an
   * all-project document search every turn, while `query` still needs to pass
   * through to rank memories.
   */
  includeDocuments?: boolean;
  /**
   * Switches the memory store off even when the request would otherwise reach
   * it. Default `true`. The mirror of {@link SearchKnowledgeArgs.includeDocuments},
   * for a caller that wants documents alone.
   */
  includeMemories?: boolean;
  policyWhere?: KnowledgePolicyWhere;
};

/**
 * The caller's compiled policy, one clause per store the search reads. Keyed
 * by resource type because each clause names columns of a different model, and
 * a clause applied to the wrong one either throws or filters nothing.
 */
export type KnowledgePolicyWhere = MemoryStorePolicyWhere & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  document?: Record<string, any>;
};

const namesAny = (...filters: Array<string[] | undefined>): boolean => {
  return filters.some((filter) => {
    return filter !== undefined && filter.length > 0;
  });
};

/**
 * Which stores this search reads.
 *
 * A `query` names no store, so it reaches **both**: a caller who asked for
 * "everything I can see" gets it. Store-specific filters narrow within a
 * store rather than choosing between them, and `include_*` is the only way to
 * take one out — a flag the caller set, never overridden by a filter that
 * happens to name the other store.
 */
const getSearchFlags = (
  args: SearchKnowledgeArgs
): { hasDocumentSearch: boolean; hasMemoryStoreSearch: boolean } => {
  // `query` and `tags` name no store, so either one reaches both.
  const everyStore = args.query !== undefined || hasTagFilter(args.tags);
  const hasDocumentSearch =
    args.includeDocuments !== false &&
    (everyStore ||
      namesAny(args.paths, args.documentIds) ||
      hasMetadataFilter(args.metadata));
  const hasMemoryStoreSearch =
    args.includeMemories !== false &&
    (everyStore || namesAny(args.memoryStoreIds));
  return { hasDocumentSearch, hasMemoryStoreSearch };
};

const toDocumentResult = (doc: QueryDocumentResult): KnowledgeResult => {
  return {
    source_type: 'document' as const,
    document_id: doc.id,
    chunk_id: doc.chunk_id,
    file_id: doc.file_id,
    project_id: doc.project_id,
    path: doc.path,
    filename: doc.filename,
    size: doc.size,
    title: doc.title,
    metadata: doc.metadata,
    tags: doc.tags,
    content: doc.content,
    page: doc.page,
    similarity_score: doc.similarity_score,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
};

const toDocumentCandidate = (
  candidate: SignalCandidate<QueryDocumentResult>
): SignalCandidate<KnowledgeResult> => {
  return { item: toDocumentResult(candidate.item), signal: candidate.signal };
};

/**
 * What a store contributes when the search never reached it — carrying the same
 * discriminant that store would have returned for this request, so a skipped
 * store needs no special case downstream.
 */
const emptyCandidates = <T>(query?: string): SearchCandidates<T> => {
  return query
    ? { ranked: true, vector: [], lexical: [] }
    : { ranked: false, results: [] };
};

/**
 * `ranked` follows the request's `query` in both stores, so these two are
 * narrowings of the union rather than branches on store behavior: exactly one
 * of them is non-empty for any one search.
 */
const signalShardsOf = <T>(
  candidates: SearchCandidates<T>
): {
  vector: Array<SignalCandidate<T>>;
  lexical: Array<SignalCandidate<T>>;
} => {
  return candidates.ranked ? candidates : { vector: [], lexical: [] };
};

const orderedResultsOf = <T>(candidates: SearchCandidates<T>): T[] => {
  return candidates.ranked ? [] : candidates.results;
};

/** The recency blend's one input beyond the clock: which results carry a fact. */
const isMemoryResult = (result: KnowledgeResult): boolean => {
  return result.source_type === 'memory';
};

/**
 * Fusion identity. A chunk and an entry can never collide — the two id spaces
 * are prefixed — but keying on the discriminant as well says so in the code
 * rather than relying on a property of the id generator.
 */
const knowledgeKey = (result: KnowledgeResult): string => {
  return result.source_type === 'document'
    ? `document:${result.chunk_id}`
    : `memory:${result.memory_id}`;
};

export const searchKnowledge = async (
  args: SearchKnowledgeArgs
): Promise<KnowledgeResult[]> => {
  const { hasDocumentSearch, hasMemoryStoreSearch } = getSearchFlags(args);
  // Clamped here rather than at the route: every caller — the search route,
  // agent knowledge injection and the orchestration node — reaches the vector
  // scan through this one function.
  const limit = clampKnowledgeSearchLimit(args.limit);

  // Once, for both stores. Embedding per store would bill the same text twice
  // and let the halves disagree: one call failing would leave documents with a
  // `similarity_score` and memory stores without, which the contract reserves for a
  // search that answered from the lexical channel alone.
  const metadataWhere = compileMetadataWhere({
    filter: args.metadata,
    column: DOCUMENT_METADATA_COLUMN,
  });

  const embedding = args.query
    ? await embedQueryOrDegrade({
        text: args.query,
        projectId: args.billingProjectId,
      })
    : undefined;

  const [documents, memoryStores] = await Promise.all([
    hasDocumentSearch
      ? resolveDocumentSearchLists({
          projectIds: args.projectIds,
          embedding,
          policyWhere: args.policyWhere?.document,
          config: {
            search: args.query,
            minSimilarity: args.minSimilarity,
            limit,
            paths: args.paths,
            documentIds: args.documentIds,
            tags: args.tags,
            metadataWhere,
          },
        })
      : Promise.resolve(emptyCandidates<QueryDocumentResult>(args.query)),
    hasMemoryStoreSearch
      ? resolveMemoryStoreSearchLists({
          projectIds: args.projectIds,
          embedding,
          policyWhere: args.policyWhere,
          config: {
            memoryStoreIds: args.memoryStoreIds,
            tags: args.tags,
            search: args.query,
            minSimilarity: args.minSimilarity,
            limit,
          },
        })
      : Promise.resolve(emptyCandidates<MemoryKnowledgeResult>(args.query)),
  ]);

  if (!args.query) {
    // No query, no ranking signal: each store contributed its one deterministic
    // read — chunk order, then oldest-first entries.
    return [
      ...orderedResultsOf(documents).map(toDocumentResult),
      ...orderedResultsOf(memoryStores),
    ].slice(0, limit);
  }

  const documentShards = signalShardsOf(documents);
  const memoryStoreShards = signalShardsOf(memoryStores);

  // Two rankings, not four: each signal's per-store shards are merged on that
  // signal's own comparable value first, so a store cannot claim result slots
  // by position alone. See `mergeSignalShards`.
  return fuseCandidates<KnowledgeResult>({
    vector: [
      documentShards.vector.map(toDocumentCandidate),
      memoryStoreShards.vector,
    ],
    lexical: [
      documentShards.lexical.map(toDocumentCandidate),
      memoryStoreShards.lexical,
    ],
    keyOf: knowledgeKey,
    rrfK: args.rrfK,
    isMemory: isMemoryResult,
    recencyHalfLifeDays: args.recencyHalfLifeDays,
    limit,
  });
};
