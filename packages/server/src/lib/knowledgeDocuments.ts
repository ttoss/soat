import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { mapDocument } from './documentMapper';
import type { EmbeddingBillingProjectId } from './embedding';
import { distanceExpression, embedQueryOrDegrade } from './knowledgeEmbedding';
import {
  lexicalMatchWhere,
  lexicalRankExpression,
  withLexicalDegrade,
} from './knowledgeLexical';
import type { SearchCandidates, SignalCandidate } from './knowledgeRanking';
import {
  fuseByReciprocalRank,
  mergeSignalShards,
  resolveRrfK,
} from './knowledgeRanking';
import { hasPolicyConstraints, referencesAssociation } from './policyWhere';
import { clampKnowledgeSearchLimit } from './requestBounds';
import { applyTagFilter } from './tags';
import { withIterativeVectorScan } from './vectorSearch';

/**
 * The document store's half of knowledge retrieval: the two candidate queries a
 * search runs over `document_chunks`, and the mapping from chunk rows to search
 * results. `knowledge.ts` reads this store and `knowledgeMemory.ts` together;
 * nothing here knows the other store exists.
 */

export type DocumentQueryConfig = {
  search?: string;
  /**
   * Raw-cosine floor a **vector** candidate must clear to be ranked. Lexical
   * candidates are never subject to it.
   */
  minSimilarity?: number;
  rrfK?: number;
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

/** Sequelize fragment types `@ttoss/postgresdb` does not re-export. */
type Literal = ReturnType<typeof db.sequelize.literal>;
type ChunkWhere = NonNullable<
  NonNullable<Parameters<typeof db.DocumentChunk.findAll>[0]>['where']
>;

type ChunkWithDocument = InstanceType<(typeof db)['DocumentChunk']> & {
  document?: InstanceType<(typeof db)['Document']> & {
    file?: InstanceType<(typeof db)['File']> & {
      project?: InstanceType<(typeof db)['Project']>;
    };
  };
};

/**
 * The row's raw cosine similarity, or `undefined` when the query never
 * embedded — the select carries `distance` on both candidate lists, so a
 * lexical-only hit has it too, and only the degrade path leaves it absent.
 */
const readChunkSimilarity = (chunk: ChunkWithDocument): number | undefined => {
  const distance = chunk.getDataValue('distance') as string | undefined;
  if (distance === undefined || distance === null) return undefined;
  return 1 - parseFloat(distance);
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

/** `score` is left to the fusion step, which is the only place that knows it. */
const mapChunkResult = (chunk: ChunkWithDocument): QueryDocumentResult => {
  const doc = chunk.document;
  const base = doc ? mapDocument(doc) : null;

  return {
    id: doc ? doc.publicId : '',
    chunk_id: chunk.publicId,
    ...pickDocumentFields(base),
    content: chunk.content,
    page: chunk.pageNumber ?? undefined,
    similarity_score: readChunkSimilarity(chunk),
    created_at: chunk.createdAt,
    updated_at: chunk.updatedAt,
  };
};

/**
 * Drops vector candidates whose raw cosine sits below the floor, before fusion.
 *
 * The floor is on cosine because that is the only thing it has ever measured:
 * `score` used to equal `similarity_score`, so the old `min_score` filtered
 * cosine by identity. Applying it to the fused value instead would turn it into
 * a rank cutoff in disguise — `1 / (k + 1)` is the same number for the best
 * result of a perfect list and the best of a useless one.
 */
const applySimilarityFloor = <T>(args: {
  candidates: Array<SignalCandidate<T>>;
  minSimilarity?: number;
}): Array<SignalCandidate<T>> => {
  const { minSimilarity } = args;
  if (minSimilarity === undefined) return args.candidates;
  return args.candidates.filter((candidate) => {
    // The vector shard's `signal` *is* the raw cosine, so this reads the same
    // number `similarity_score` reports.
    return candidate.signal >= minSimilarity;
  });
};

const toVectorCandidate = (
  chunk: ChunkWithDocument
): SignalCandidate<QueryDocumentResult> => {
  return {
    item: mapChunkResult(chunk),
    signal: readChunkSimilarity(chunk) ?? 0,
  };
};

const toLexicalCandidate = (
  chunk: ChunkWithDocument
): SignalCandidate<QueryDocumentResult> => {
  return {
    item: mapChunkResult(chunk),
    signal: parseFloat(
      (chunk.getDataValue('lexicalRank') as string | undefined) ?? '0'
    ),
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

const CHUNK_CONTENT_COLUMN = '"DocumentChunk"."content"';
const CHUNK_EMBEDDING_COLUMN = '"DocumentChunk"."embedding"';

/**
 * The chunk columns a candidate list selects beyond the model's own.
 *
 * `distance` rides along on the lexical query too, so a hit only that query
 * found still reports its cosine: the query vector is already computed and the
 * row's embedding is already in the table, so it costs one column over a
 * bounded result set. `lexicalRank` is selected rather than only ordered by,
 * because merging this store's shard with the other one needs the value, not
 * just the order.
 */
const chunkAttributes = (args: {
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

const findChunksByVector = async (args: {
  distanceLiteral: Literal;
  docInclude: unknown;
  limit: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topLevelWhere?: Record<string, any>;
}): Promise<ChunkWithDocument[]> => {
  return withIterativeVectorScan({
    run: ({ transaction }) => {
      return db.DocumentChunk.findAll({
        where: args.topLevelWhere,
        attributes: chunkAttributes({ distanceLiteral: args.distanceLiteral }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        include: [args.docInclude] as any,
        order: args.distanceLiteral,
        subQuery: referencesAssociation(args.topLevelWhere) ? false : undefined,
        limit: args.limit,
        transaction,
      }) as unknown as Promise<ChunkWithDocument[]>;
    },
  });
};

/**
 * The same query under the same scope filters, ranked by `ts_rank_cd` instead
 * of cosine distance. Reusing `topLevelWhere` and `docInclude` verbatim is what
 * keeps the compiled policy clause — and every other filter — identical across
 * the two channels; a chunk the policy excludes is not a lexical candidate
 * either.
 */
const findChunksByLexical = async (args: {
  query: string;
  distanceLiteral?: Literal;
  docInclude: unknown;
  limit: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topLevelWhere?: Record<string, any>;
}): Promise<ChunkWithDocument[]> => {
  const lexicalMatch = lexicalMatchWhere({
    column: CHUNK_CONTENT_COLUMN,
    query: args.query,
  });
  const lexicalRank = lexicalRankExpression({
    column: CHUNK_CONTENT_COLUMN,
    query: args.query,
  });

  return withLexicalDegrade({
    source: 'documents',
    run: () => {
      return db.DocumentChunk.findAll({
        where: {
          [Op.and]: [
            ...(args.topLevelWhere ? [args.topLevelWhere] : []),
            lexicalMatch,
          ],
        } as ChunkWhere,
        attributes: chunkAttributes({
          distanceLiteral: args.distanceLiteral,
          lexicalRank,
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        include: [args.docInclude] as any,
        order: [[lexicalRank, 'DESC']],
        subQuery: referencesAssociation(args.topLevelWhere) ? false : undefined,
        limit: args.limit,
      }) as unknown as Promise<ChunkWithDocument[]>;
    },
  });
};

/**
 * The document half's ranked candidate lists: vector first, lexical second.
 *
 * They run in parallel — neither needs the other's rows — and either may come
 * back empty: the vector list when the embedding provider is unreachable, the
 * lexical one when its query fails or simply matches nothing, which under a
 * `simple` configuration is the common case for a natural-language query.
 */
const findChunksWithSearch = async (args: {
  config: DocumentQueryConfig;
  billingProjectId: EmbeddingBillingProjectId;
  docWhere: Record<string, unknown> | undefined;
  fileInclude: ReturnType<typeof buildFileInclude>;
  limit: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topLevelWhere?: Record<string, any>;
}): Promise<ChunkWithDocument[][]> => {
  const search = args.config.search!;
  const embedding = await embedQueryOrDegrade({
    text: search,
    projectId: args.billingProjectId,
  });
  const distanceLiteral = embedding
    ? db.DocumentChunk.sequelize!.literal(
        distanceExpression({ column: CHUNK_EMBEDDING_COLUMN, embedding })
      )
    : undefined;

  const docInclude = buildDocumentInclude({
    docWhere: args.docWhere,
    fileInclude: args.fileInclude,
  });

  const [vector, lexical] = await Promise.all([
    distanceLiteral
      ? findChunksByVector({
          distanceLiteral,
          docInclude,
          limit: args.limit,
          topLevelWhere: args.topLevelWhere,
        })
      : Promise.resolve([]),
    findChunksByLexical({
      query: search,
      distanceLiteral,
      docInclude,
      limit: args.limit,
      topLevelWhere: args.topLevelWhere,
    }),
  ]);

  return [vector, lexical];
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

/**
 * The document store's shard of each signal, when `config.search` is set; the
 * deterministic chunk-order read, which no signal ranks, when it is not.
 */
export const resolveDocumentSearchLists = async (args: {
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
}): Promise<SearchCandidates<QueryDocumentResult>> => {
  const { config, projectIds } = args;
  const limit = clampKnowledgeSearchLimit(config.limit);

  if (projectIds !== undefined && projectIds.length === 0) {
    return config.search
      ? { ranked: true, vector: [], lexical: [] }
      : { ranked: false, results: [] };
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

  if (!config.search) {
    const rawChunks = await findChunksWithoutSearch({
      docWhere,
      fileInclude,
      limit,
      topLevelWhere: effectivePolicyWhere,
    });
    return { ranked: false, results: rawChunks.map(mapChunkResult) };
  }

  const [vector, lexical] = await findChunksWithSearch({
    config,
    billingProjectId: args.billingProjectId,
    docWhere,
    fileInclude,
    limit,
    topLevelWhere: effectivePolicyWhere,
  });

  return {
    ranked: true,
    vector: applySimilarityFloor({
      candidates: vector.map(toVectorCandidate),
      minSimilarity: config.minSimilarity,
    }),
    // Never floored: a chunk that literally contains the searched token is the
    // evidence, and dropping it for a low cosine re-creates the defect hybrid
    // retrieval exists to fix.
    lexical: lexical.map(toLexicalCandidate),
  };
};

/**
 * Ranks documents alone. `searchKnowledge` is the path that reads both stores;
 * this one exists for callers that only ever read documents, and fuses the two
 * signals over a single store's shard of each.
 */
export const resolveDocumentSearch = async (args: {
  projectIds?: number[];
  billingProjectId: EmbeddingBillingProjectId;
  config: DocumentQueryConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
}): Promise<QueryDocumentResult[]> => {
  const candidates = await resolveDocumentSearchLists(args);
  if (!candidates.ranked) return candidates.results;

  return fuseByReciprocalRank({
    lists: [
      mergeSignalShards({ shards: [candidates.vector] }),
      mergeSignalShards({ shards: [candidates.lexical] }),
    ],
    keyOf: (result) => {
      return result.chunk_id;
    },
    k: resolveRrfK(args.config.rrfK),
  })
    .slice(0, clampKnowledgeSearchLimit(args.config.limit))
    .map((fused) => {
      return { ...fused.item, score: fused.score };
    });
};
