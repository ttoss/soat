import type { KnowledgeResult } from './knowledge';

/**
 * One result `knowledge_config` retrieval injected into a turn, as recorded on
 * the generation. Pointers only — the text stays in the store it came from,
 * so the record is not content and outlives a purge.
 *
 * `document_version` is what makes the pointer durable: a chunk id stops
 * resolving once its document is re-chunked, while the archived version keeps
 * the text the turn read.
 *
 * The array is in injection order, so the rank needs no field. The fused
 * `score` is left out: it is comparable only within one search response,
 * while raw cosine keeps its meaning once stored.
 */
export type KnowledgeRetrievalEntry =
  | {
      source_type: 'document';
      document_id: string;
      document_version: number;
      chunk_id: string;
      page: number | null;
      similarity_score: number | null;
    }
  | {
      source_type: 'memory';
      memory_store_id: string;
      memory_id: string;
      similarity_score: number | null;
    };

/** Null means no retrieval ran; empty means it ran and matched nothing. */
export type KnowledgeRetrieval = KnowledgeRetrievalEntry[] | null;

export const toKnowledgeRetrieval = (
  results: KnowledgeResult[]
): KnowledgeRetrievalEntry[] => {
  return results.map((result): KnowledgeRetrievalEntry => {
    if (result.source_type === 'document') {
      return {
        source_type: 'document',
        document_id: result.document_id,
        document_version: result.document_version,
        chunk_id: result.chunk_id,
        page: result.page ?? null,
        similarity_score: result.similarity_score ?? null,
      };
    }
    return {
      source_type: 'memory',
      memory_store_id: result.memory_store_id,
      memory_id: result.memory_id,
      similarity_score: result.similarity_score ?? null,
    };
  });
};
