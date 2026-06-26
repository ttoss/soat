import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { getEmbedding } from './embedding';
import type { MemoryKnowledgeResult } from './knowledgeMemory';
import { resolveMemorySearch } from './knowledgeMemory';

export type { MemoryQueryConfig } from './knowledgeMemory';

// ── Shared document mapper ───────────────────────────────────────────────

const parseMetadata = (metadata: string | null | undefined): unknown => {
  if (!metadata) return undefined;
  try {
    return JSON.parse(metadata);
  } catch {
    return metadata;
  }
};

export const mapDocument = (
  doc: InstanceType<(typeof db)['Document']> & {
    file?: InstanceType<(typeof db)['File']> & {
      project?: InstanceType<(typeof db)['Project']>;
    };
  }
) => {
  return {
    id: doc.publicId,
    fileId: doc.file?.publicId,
    projectId: doc.file?.project?.publicId,
    path: doc.file?.path ?? undefined,
    filename: doc.file?.filename,
    size: doc.file?.size,
    title: doc.title ?? undefined,
    metadata: parseMetadata(doc.metadata),
    tags: doc.tags ?? undefined,
    status: doc.status as
      | 'pending'
      | 'processing'
      | 'ready'
      | 'failed'
      | undefined,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

// ── Types ────────────────────────────────────────────────────────────────

export type DocumentQueryConfig = {
  search?: string;
  minScore?: number;
  limit?: number;
  paths?: string[];
  documentIds?: string[];
};

export type QueryDocumentResult = {
  id: string;
  chunkId: string;
  fileId?: string;
  projectId?: string;
  path?: string;
  filename?: string;
  size?: number;
  title?: string;
  metadata?: unknown;
  tags?: Record<string, string>;
  content: string | null;
  page?: number;
  similarityScore?: number;
  createdAt: Date;
  updatedAt: Date;
};

export type KnowledgeResult =
  | {
      sourceType: 'document';
      documentId: string;
      chunkId: string;
      fileId?: string;
      projectId?: string;
      path?: string;
      filename?: string;
      size?: number;
      title?: string;
      metadata?: unknown;
      tags?: Record<string, string>;
      content: string | null;
      page?: number;
      similarityScore?: number;
      createdAt: Date;
      updatedAt: Date;
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
        return { path: { [Op.like]: `${p}%` } };
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
  | 'fileId'
  | 'projectId'
  | 'path'
  | 'filename'
  | 'size'
  | 'title'
  | 'metadata'
  | 'tags'
> => {
  if (!base) {
    return {
      fileId: undefined,
      projectId: undefined,
      path: undefined,
      filename: undefined,
      size: undefined,
      title: undefined,
      metadata: undefined,
      tags: undefined,
    };
  }
  return {
    fileId: base.fileId,
    projectId: base.projectId,
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
    chunkId: chunk.publicId,
    ...pickDocumentFields(base),
    content: chunk.content,
    page: chunk.pageNumber ?? undefined,
    similarityScore,
    createdAt: chunk.createdAt,
    updatedAt: chunk.updatedAt,
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
  docWhere: Record<string, unknown> | undefined;
  fileInclude: ReturnType<typeof buildFileInclude>;
  limit: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topLevelWhere?: Record<string, any>;
}): Promise<ChunkWithDocument[]> => {
  const embedding = await getEmbedding({ text: args.config.search! });
  const embeddingLiteral = `[${embedding.join(',')}]`;
  const distanceLiteral = db.DocumentChunk.sequelize!.literal(
    `"DocumentChunk"."embedding" <=> '${embeddingLiteral}'`
  );

  const docInclude = buildDocumentInclude({
    docWhere: args.docWhere,
    fileInclude: args.fileInclude,
  });

  const needsSubQueryFalse =
    args.topLevelWhere !== undefined &&
    Object.keys(args.topLevelWhere).some((k) => {
      return k.startsWith('$');
    });

  return db.DocumentChunk.findAll({
    where: args.topLevelWhere,
    attributes: { include: [[distanceLiteral, 'distance']] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    include: [docInclude] as any,
    order: distanceLiteral,
    subQuery: needsSubQueryFalse ? false : undefined,
    limit: args.limit,
  }) as unknown as Promise<ChunkWithDocument[]>;
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

  const needsSubQueryFalse =
    args.topLevelWhere !== undefined &&
    Object.keys(args.topLevelWhere).some((k) => {
      return k.startsWith('$');
    });

  return db.DocumentChunk.findAll({
    where: args.topLevelWhere,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    include: [docInclude] as any,
    order: [['chunkIndex', 'ASC']],
    subQuery: needsSubQueryFalse ? false : undefined,
    limit: args.limit,
  }) as unknown as Promise<ChunkWithDocument[]>;
};

const buildDocWhere = (args: {
  documentIds: string[] | undefined;
}): Record<string, unknown> | undefined => {
  if (!args.documentIds || args.documentIds.length === 0) return undefined;
  return { publicId: args.documentIds };
};

export const resolveDocumentSearch = async (args: {
  projectIds?: number[];
  config: DocumentQueryConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
}): Promise<QueryDocumentResult[]> => {
  const { config, projectIds } = args;
  const limit = config.limit ?? 10;

  if (projectIds !== undefined && projectIds.length === 0) {
    return [];
  }

  const effectivePolicyWhere =
    args.policyWhere && Object.keys(args.policyWhere).length > 0
      ? args.policyWhere
      : undefined;

  const fileInclude = buildFileInclude({ projectIds, paths: config.paths });
  const docWhere = buildDocWhere({ documentIds: config.documentIds });

  const rawChunks = config.search
    ? await findChunksWithSearch({
        config,
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
    return (r.similarityScore ?? -1) >= minScore;
  });
};

type SearchKnowledgeArgs = {
  projectIds?: number[];
  query?: string;
  minScore?: number;
  limit?: number;
  paths?: string[];
  documentIds?: string[];
  memoryIds?: string[];
  memoryTags?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
};

const getSearchFlags = (
  args: SearchKnowledgeArgs
): { hasDocumentSearch: boolean; hasMemorySearch: boolean } => {
  const hasDocumentSearch =
    args.query !== undefined ||
    (args.paths !== undefined && args.paths.length > 0) ||
    (args.documentIds !== undefined && args.documentIds.length > 0);
  const hasMemorySearch =
    (args.memoryIds !== undefined && args.memoryIds.length > 0) ||
    (args.memoryTags !== undefined && args.memoryTags.length > 0);
  return { hasDocumentSearch, hasMemorySearch };
};

export const searchKnowledge = async (
  args: SearchKnowledgeArgs
): Promise<KnowledgeResult[]> => {
  const { hasDocumentSearch, hasMemorySearch } = getSearchFlags(args);

  const [docs, memoryEntries] = await Promise.all([
    !hasMemorySearch || hasDocumentSearch
      ? resolveDocumentSearch({
          projectIds: args.projectIds,
          policyWhere: args.policyWhere,
          config: {
            search: args.query,
            minScore: args.minScore,
            limit: args.limit,
            paths: args.paths,
            documentIds: args.documentIds,
          },
        })
      : Promise.resolve([]),
    hasMemorySearch
      ? resolveMemorySearch({
          projectIds: args.projectIds,
          config: {
            memoryIds: args.memoryIds,
            memoryTags: args.memoryTags,
            search: args.query,
            minScore: args.minScore,
            limit: args.limit,
          },
        })
      : Promise.resolve([]),
  ]);

  const docResults: KnowledgeResult[] = docs.map((doc) => {
    return {
      sourceType: 'document' as const,
      documentId: doc.id,
      chunkId: doc.chunkId,
      fileId: doc.fileId,
      projectId: doc.projectId,
      path: doc.path,
      filename: doc.filename,
      size: doc.size,
      title: doc.title,
      metadata: doc.metadata,
      tags: doc.tags,
      content: doc.content,
      page: doc.page,
      similarityScore: doc.similarityScore,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  });

  const allResults = [...docResults, ...memoryEntries];

  if (args.query) {
    allResults.sort((a, b) => {
      const aScore = a.similarityScore ?? 0;
      const bScore = b.similarityScore ?? 0;
      return bScore - aScore;
    });
  }

  const limit = args.limit ?? 10;
  return allResults.slice(0, limit);
};
