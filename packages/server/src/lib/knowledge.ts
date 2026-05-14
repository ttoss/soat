import fs from 'node:fs';

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
  fileId?: string;
  projectId?: string;
  path?: string;
  filename?: string;
  size?: number;
  title?: string;
  metadata?: unknown;
  tags?: Record<string, string>;
  content: string | null;
  score?: number;
  createdAt: Date;
  updatedAt: Date;
};

export type KnowledgeResult =
  | {
      sourceType: 'document';
      documentId: string;
      fileId?: string;
      projectId?: string;
      path?: string;
      filename?: string;
      size?: number;
      title?: string;
      metadata?: unknown;
      tags?: Record<string, string>;
      content: string | null;
      score?: number;
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

const mapRawDocument = (
  doc: InstanceType<(typeof db)['Document']>,
  config: DocumentQueryConfig
) => {
  const base = mapDocument(doc);
  let content: string | null = null;
  if (doc.file?.storagePath && fs.existsSync(doc.file.storagePath)) {
    content = fs.readFileSync(doc.file.storagePath, 'utf-8');
  }
  if (config.search) {
    const distance = parseFloat(
      (doc.getDataValue('distance') as string) ?? '1'
    );
    return { ...base, content, score: 1 - distance };
  }
  return { ...base, content };
};

// ── Query engine ─────────────────────────────────────────────────────────

const findDocumentsWithSearch = async (args: {
  config: DocumentQueryConfig;
  fileInclude: unknown;
  effectiveDocWhere: unknown;
  needsSubQueryFalse: boolean;
  limit: number;
}): Promise<Array<InstanceType<(typeof db)['Document']>>> => {
  const embedding = await getEmbedding({ text: args.config.search! });
  const embeddingLiteral = `[${embedding.join(',')}]`;

  return db.Document.findAll({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where: args.effectiveDocWhere as any,
    attributes: {
      include: [
        [
          db.Document.sequelize!.literal(`embedding <=> '${embeddingLiteral}'`),
          'distance',
        ],
      ],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    include: [args.fileInclude] as any,
    order: db.Document.sequelize!.literal(
      `embedding <=> '${embeddingLiteral}'`
    ),
    subQuery: args.needsSubQueryFalse ? false : undefined,
    limit: args.limit,
  });
};

const findDocumentsWithoutSearch = async (args: {
  fileInclude: unknown;
  effectiveDocWhere: unknown;
  needsSubQueryFalse: boolean;
  limit: number;
}): Promise<Array<InstanceType<(typeof db)['Document']>>> => {
  return db.Document.findAll({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where: args.effectiveDocWhere as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    include: [args.fileInclude] as any,
    order: [['createdAt', 'ASC']],
    subQuery: args.needsSubQueryFalse ? false : undefined,
    limit: args.limit,
  });
};

const mergeWhereClauses = (
  docWhere: unknown,
  policyWhere: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merged: Record<string, any> = {
    ...(docWhere ?? {}),
    ...(policyWhere ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
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

  const fileInclude = buildFileInclude({ projectIds, paths: config.paths });
  const docWhere =
    config.documentIds && config.documentIds.length > 0
      ? { publicId: config.documentIds }
      : undefined;

  const effectiveDocWhere = mergeWhereClauses(docWhere, args.policyWhere);
  const needsSubQueryFalse =
    !!args.policyWhere &&
    Object.keys(args.policyWhere).some((k) => {
      return k.startsWith('$');
    });

  const rawDocuments = config.search
    ? await findDocumentsWithSearch({
        config,
        fileInclude,
        effectiveDocWhere,
        needsSubQueryFalse,
        limit,
      })
    : await findDocumentsWithoutSearch({
        fileInclude,
        effectiveDocWhere,
        needsSubQueryFalse,
        limit,
      });

  const mapped = rawDocuments.map((doc) => {
    return mapRawDocument(doc, config);
  });
  if (!config.search || config.minScore === undefined) return mapped;
  const minScore = config.minScore;
  return mapped.filter((doc) => {
    return ('score' in doc ? (doc.score ?? -1) : -1) >= minScore;
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
      fileId: doc.fileId,
      projectId: doc.projectId,
      path: doc.path,
      filename: doc.filename,
      size: doc.size,
      title: doc.title,
      metadata: doc.metadata,
      tags: doc.tags,
      content: doc.content,
      score: doc.score,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  });

  const allResults = [...docResults, ...memoryEntries];

  // Sort by score descending when available, otherwise keep original order
  if (args.query) {
    allResults.sort((a, b) => {
      const aScore = a.score ?? 0;
      const bScore = b.score ?? 0;
      return bScore - aScore;
    });
  }

  const limit = args.limit ?? 10;
  return allResults.slice(0, limit);
};
