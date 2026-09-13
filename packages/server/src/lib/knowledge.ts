import type { EmbeddingBillingProjectId } from './embedding';
import type { QueryDocumentResult } from './knowledgeDocuments';
import { resolveDocumentSearchLists } from './knowledgeDocuments';
import { embedQueryOrDegrade } from './knowledgeEmbedding';
import type {
  MemoryKnowledgeResult,
  MemoryPolicyWhere,
} from './knowledgeMemory';
import { resolveMemorySearchLists } from './knowledgeMemory';
import type { SearchCandidates, SignalCandidate } from './knowledgeRanking';
import { fuseCandidates } from './knowledgeRanking';
import { clampKnowledgeSearchLimit } from './requestBounds';
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
  limit?: number;
  paths?: string[];
  documentIds?: string[];
  memoryIds?: string[];
  /**
   * Key-value pairs a result's own `tags` must all contain. One filter for
   * both stores: it narrows documents and memory entries alike, and is the
   * only filter that turns on a source on both sides at once.
   */
  tags?: Record<string, string>;
  /**
   * Internal-only override (not exposed on the REST search endpoint) that
   * forces document search off even when `query` is set. Callers that derive
   * `query` from context rather than an explicit caller request — e.g. agent
   * generation injection deriving it from the chat message — use this to keep
   * a memory-scoped config from silently widening into an all-project
   * document search, while still passing `query` through for memory ranking.
   */
  includeDocuments?: boolean;
  policyWhere?: KnowledgePolicyWhere;
};

/**
 * The caller's compiled policy, one clause per store the search reads. Keyed
 * by resource type because each clause names columns of a different model, and
 * a clause applied to the wrong one either throws or filters nothing.
 */
export type KnowledgePolicyWhere = MemoryPolicyWhere & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  document?: Record<string, any>;
};

const getSearchFlags = (
  args: SearchKnowledgeArgs
): { hasDocumentSearch: boolean; hasMemorySearch: boolean } => {
  const hasDocumentSearch =
    args.includeDocuments !== false &&
    (args.query !== undefined ||
      (args.paths !== undefined && args.paths.length > 0) ||
      (args.documentIds !== undefined && args.documentIds.length > 0) ||
      hasTagFilter(args.tags));
  const hasMemorySearch =
    (args.memoryIds !== undefined && args.memoryIds.length > 0) ||
    hasTagFilter(args.tags);
  return { hasDocumentSearch, hasMemorySearch };
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

/**
 * Fusion identity. A chunk and an entry can never collide — the two id spaces
 * are prefixed — but keying on the discriminant as well says so in the code
 * rather than relying on a property of the id generator.
 */
const knowledgeKey = (result: KnowledgeResult): string => {
  return result.source_type === 'document'
    ? `document:${result.chunk_id}`
    : `memory:${result.entry_id}`;
};

export const searchKnowledge = async (
  args: SearchKnowledgeArgs
): Promise<KnowledgeResult[]> => {
  const { hasDocumentSearch, hasMemorySearch } = getSearchFlags(args);
  // Clamped here rather than at the route: every caller — the search route,
  // agent knowledge injection and the orchestration node — reaches the vector
  // scan through this one function.
  const limit = clampKnowledgeSearchLimit(args.limit);

  // Once, for both stores. Embedding per store would bill the same text twice
  // and let the halves disagree: one call failing would leave documents with a
  // `similarity_score` and memories without, which the contract reserves for a
  // search that answered from the lexical channel alone.
  const embedding = args.query
    ? await embedQueryOrDegrade({
        text: args.query,
        projectId: args.billingProjectId,
      })
    : undefined;

  const [documents, memories] = await Promise.all([
    !hasMemorySearch || hasDocumentSearch
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
          },
        })
      : Promise.resolve(emptyCandidates<QueryDocumentResult>(args.query)),
    hasMemorySearch
      ? resolveMemorySearchLists({
          projectIds: args.projectIds,
          embedding,
          policyWhere: args.policyWhere,
          config: {
            memoryIds: args.memoryIds,
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
      ...orderedResultsOf(memories),
    ].slice(0, limit);
  }

  const documentShards = signalShardsOf(documents);
  const memoryShards = signalShardsOf(memories);

  // Two rankings, not four: each signal's per-store shards are merged on that
  // signal's own comparable value first, so a store cannot claim result slots
  // by position alone. See `mergeSignalShards`.
  return fuseCandidates<KnowledgeResult>({
    vector: [
      documentShards.vector.map(toDocumentCandidate),
      memoryShards.vector,
    ],
    lexical: [
      documentShards.lexical.map(toDocumentCandidate),
      memoryShards.lexical,
    ],
    keyOf: knowledgeKey,
    rrfK: args.rrfK,
    limit,
  });
};
