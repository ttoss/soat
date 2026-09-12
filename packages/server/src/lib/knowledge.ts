import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { mapDocument } from './documentMapper';
import type { EmbeddingBillingProjectId } from './embedding';
import { getEmbedding } from './embedding';
import type {
  MemoryKnowledgeResult,
  MemoryPolicyWhere,
} from './knowledgeMemory';
import { resolveMemorySearch } from './knowledgeMemory';
import { hasPolicyConstraints, referencesAssociation } from './policyWhere';
import { clampKnowledgeSearchLimit } from './requestBounds';
import { applyTagFilter, hasTagFilter } from './tags';
import { withIterativeVectorScan } from './vectorSearch';

export type { MemoryQueryConfig } from './knowledgeMemory';

// ── Types ────────────────────────────────────────────────────────────────

export type DocumentQueryConfig = {
  search?: string;
  minScore?: number;
  limit?: number;
  paths?: string[];
  documentIds?: string[];
  tags?: Record<string, string>;
};

export type QueryDocumentResult = {
  id: string;
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
  score?: number;
  similarity_score?: number;
  created_at: Date;
  updated_at: Date;
};

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
       * Implementation-defined relevance ranking — higher is better. The
       * ordering it produces is the contract; the absolute value is not.
       * `similarity_score` stays pinned to raw cosine.
       */
      score?: number;
      similarity_score?: number;
      created_at: Date;
      updated_at: Date;
    }
  | MemoryKnowledgeResult;

// ── Private helpers ──────────────────────────────────────────────────────

const buildFileInclude = (args: {
  projectIds?: number[];
  paths?: string[];
}) => {
  const conditions: unknown[] = [];
  if (args.projectIds !== undefined) {
    conditions.push({ projectId: args.projectIds });
  }
  if (args.paths && args.paths.length > 0) {
    conditions.push({
      [Op.or]: args.paths.map((p) => {
        // Stored paths are leading-slash normalized, so a prefix without one
        // must be too or the `LIKE` never fires. The trailing slash stays, to
        // keep folder-prefix semantics.
        const prefix = p.startsWith('/') ? p : `/${p}`;
        return { path: { [Op.like]: `${prefix}%` } };
      }),
    });
  }
  const where = conditions.length > 0 ? { [Op.and]: conditions } : undefined;
  return {
    model: db.File,
    as: 'file',
    where: where as Record<string, unknown> | undefined,
    include: [{ model: db.Project, as: 'project' }],
  };
};

type ChunkWithDocument = InstanceType<(typeof db)['DocumentChunk']> & {
  document?: InstanceType<(typeof db)['Document']> & {
    file?: InstanceType<(typeof db)['File']> & {
      project?: InstanceType<(typeof db)['Project']>;
    };
  };
};

const computeChunkScore = (
  chunk: ChunkWithDocument,
  config: DocumentQueryConfig
): number | undefined => {
  if (!config.search) return undefined;
  const distance = parseFloat(
    (chunk.getDataValue('distance') as string) ?? '1'
  );
  return 1 - distance;
};

type DocumentBase = ReturnType<typeof mapDocument>;

const pickDocumentFields = (
  base: DocumentBase | null
): Pick<
  QueryDocumentResult,
  | 'file_id'
  | 'project_id'
  | 'path'
  | 'filename'
  | 'size'
  | 'title'
  | 'metadata'
  | 'tags'
> => {
  if (!base) {
    return {
      file_id: undefined,
      project_id: undefined,
      path: undefined,
      filename: undefined,
      size: undefined,
      title: undefined,
      metadata: undefined,
      tags: undefined,
    };
  }
  return {
    file_id: base.file_id,
    project_id: base.project_id,
    path: base.path,
    filename: base.filename,
    size: base.size,
    title: base.title,
    metadata: base.metadata,
    tags: base.tags,
  };
};

const mapChunkResult = (
  chunk: ChunkWithDocument,
  config: DocumentQueryConfig
): QueryDocumentResult => {
  const doc = chunk.document;
  const base = doc ? mapDocument(doc) : null;
  const similarityScore = computeChunkScore(chunk, config);

  return {
    id: doc ? doc.publicId : '',
    chunk_id: chunk.publicId,
    ...pickDocumentFields(base),
    content: chunk.content,
    page: chunk.pageNumber ?? undefined,
    // Single-signal ranking today, so `score` is the cosine value.
    score: similarityScore,
    similarity_score: similarityScore,
    created_at: chunk.createdAt,
    updated_at: chunk.updatedAt,
  };
};

// ── Query engine ─────────────────────────────────────────────────────────

const buildDocumentInclude = (args: {
  docWhere: Record<string, unknown> | undefined;
  fileInclude: ReturnType<typeof buildFileInclude>;
}): unknown => {
  const fileRequired = args.fileInclude.where !== undefined;
  return {
    model: db.Document,
    as: 'document',
    where: args.docWhere,
    required: args.docWhere !== undefined || fileRequired,
    include: [{ ...args.fileInclude, required: fileRequired }],
  };
};

const findChunksWithSearch = async (args: {
  config: DocumentQueryConfig;
  billingProjectId: EmbeddingBillingProjectId;
  docWhere: Record<string, unknown> | undefined;
  fileInclude: ReturnType<typeof buildFileInclude>;
  limit: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topLevelWhere?: Record<string, any>;
}): Promise<ChunkWithDocument[]> => {
  const embedding = await getEmbedding({
    text: args.config.search!,
    projectId: args.billingProjectId,
  });
  const embeddingLiteral = `[${embedding.join(',')}]`;
  const distanceLiteral = db.DocumentChunk.sequelize!.literal(
    `"DocumentChunk"."embedding" <=> '${embeddingLiteral}'`
  );

  const docInclude = buildDocumentInclude({
    docWhere: args.docWhere,
    fileInclude: args.fileInclude,
  });

  return withIterativeVectorScan({
    run: ({ transaction }) => {
      return db.DocumentChunk.findAll({
        where: args.topLevelWhere,
        attributes: { include: [[distanceLiteral, 'distance']] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        include: [docInclude] as any,
        order: distanceLiteral,
        subQuery: referencesAssociation(args.topLevelWhere) ? false : undefined,
        limit: args.limit,
        transaction,
      }) as unknown as Promise<ChunkWithDocument[]>;
    },
  });
};

const findChunksWithoutSearch = async (args: {
  docWhere: Record<string, unknown> | undefined;
  fileInclude: ReturnType<typeof buildFileInclude>;
  limit: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topLevelWhere?: Record<string, any>;
}): Promise<ChunkWithDocument[]> => {
  const docInclude = buildDocumentInclude({
    docWhere: args.docWhere,
    fileInclude: args.fileInclude,
  });

  return db.DocumentChunk.findAll({
    where: args.topLevelWhere,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    include: [docInclude] as any,
    order: [['chunkIndex', 'ASC']],
    subQuery: referencesAssociation(args.topLevelWhere) ? false : undefined,
    limit: args.limit,
  }) as unknown as Promise<ChunkWithDocument[]>;
};

const buildDocWhere = (args: {
  documentIds: string[] | undefined;
  tags: Record<string, string> | undefined;
}): Record<string, unknown> | undefined => {
  const where: Record<string, unknown> = {};
  if (args.documentIds && args.documentIds.length > 0) {
    where.publicId = args.documentIds;
  }
  applyTagFilter({ where, tags: args.tags });
  return Object.keys(where).length > 0 ? where : undefined;
};

export const resolveDocumentSearch = async (args: {
  projectIds?: number[];
  /**
   * The project the query embedding is billed to. Separate from `projectIds`,
   * which is an access filter that may name many projects or none: a search
   * that spans a caller's whole scope has no single project to charge.
   */
  billingProjectId: EmbeddingBillingProjectId;
  config: DocumentQueryConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
}): Promise<QueryDocumentResult[]> => {
  const { config, projectIds } = args;
  const limit = clampKnowledgeSearchLimit(config.limit);

  if (projectIds !== undefined && projectIds.length === 0) {
    return [];
  }

  // Compiled with `columnRoot: 'document'` by the route, so every column it
  // names is already relative to this query's root — see `resolvePolicyWhere`.
  const effectivePolicyWhere = hasPolicyConstraints(args.policyWhere)
    ? args.policyWhere
    : undefined;

  const fileInclude = buildFileInclude({ projectIds, paths: config.paths });
  const docWhere = buildDocWhere({
    documentIds: config.documentIds,
    tags: config.tags,
  });

  const rawChunks = config.search
    ? await findChunksWithSearch({
        config,
        billingProjectId: args.billingProjectId,
        docWhere,
        fileInclude,
        limit,
        topLevelWhere: effectivePolicyWhere,
      })
    : await findChunksWithoutSearch({
        docWhere,
        fileInclude,
        limit,
        topLevelWhere: effectivePolicyWhere,
      });

  const mapped = rawChunks.map((chunk) => {
    return mapChunkResult(chunk, config);
  });

  if (!config.search || config.minScore === undefined) return mapped;
  const minScore = config.minScore;
  return mapped.filter((r) => {
    // Filters on `score`, the documented ranking, so a future change to how
    // `score` is computed carries `min_score` with it automatically.
    return (r.score ?? -1) >= minScore;
  });
};

type SearchKnowledgeArgs = {
  projectIds?: number[];
  /** See {@link resolveDocumentSearch}. Required, so a caller has to say. */
  billingProjectId: EmbeddingBillingProjectId;
  query?: string;
  minScore?: number;
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

export const searchKnowledge = async (
  args: SearchKnowledgeArgs
): Promise<KnowledgeResult[]> => {
  const { hasDocumentSearch, hasMemorySearch } = getSearchFlags(args);
  // Clamped here rather than at the route: every caller — the search route,
  // agent knowledge injection and the orchestration node — reaches the vector
  // scan through this one function.
  const limit = clampKnowledgeSearchLimit(args.limit);

  const [docs, memoryEntries] = await Promise.all([
    !hasMemorySearch || hasDocumentSearch
      ? resolveDocumentSearch({
          projectIds: args.projectIds,
          billingProjectId: args.billingProjectId,
          policyWhere: args.policyWhere?.document,
          config: {
            search: args.query,
            minScore: args.minScore,
            limit,
            paths: args.paths,
            documentIds: args.documentIds,
            tags: args.tags,
          },
        })
      : Promise.resolve([]),
    hasMemorySearch
      ? resolveMemorySearch({
          projectIds: args.projectIds,
          billingProjectId: args.billingProjectId,
          policyWhere: args.policyWhere,
          config: {
            memoryIds: args.memoryIds,
            tags: args.tags,
            search: args.query,
            minScore: args.minScore,
            limit,
          },
        })
      : Promise.resolve([]),
  ]);

  const docResults: KnowledgeResult[] = docs.map((doc) => {
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
      score: doc.score,
      similarity_score: doc.similarity_score,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    };
  });

  const allResults = [...docResults, ...memoryEntries];

  if (args.query) {
    allResults.sort((a, b) => {
      // Ordering is defined against `score` — the field whose ranking is the
      // contract — not against the raw cosine kept for debugging.
      const aScore = a.score ?? 0;
      const bScore = b.score ?? 0;
      return bScore - aScore;
    });
  }

  // Top-k of an in-memory similarity search, not a page — named so it reads as
  // distinct from the `limit`/`offset` list envelope.
  return allResults.slice(0, limit);
};
