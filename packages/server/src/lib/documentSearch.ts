import fs from 'node:fs';

import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { getEmbedding } from './embedding';

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

// ── Private helpers ──────────────────────────────────────────────────────

const buildDocWhere = (documentIds?: string[]) => {
  if (!documentIds || documentIds.length === 0) return undefined;
  return { publicId: documentIds };
};

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

const checkNeedsSubQueryFalse = (
  policyWhere: Record<string, unknown> | undefined
): boolean => {
  if (!policyWhere) return false;
  return Object.keys(policyWhere).some((k) => {
    return k.startsWith('$');
  });
};

const filterByScore = (
  docs: QueryDocumentResult[],
  config: DocumentQueryConfig
): QueryDocumentResult[] => {
  if (!config.search || config.minScore === undefined) return docs;
  const minScore = config.minScore;
  return docs.filter((doc) => {
    const score = (doc as { score?: number }).score;
    return score !== undefined && score >= minScore;
  });
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
  const docWhere = buildDocWhere(config.documentIds);

  const effectiveDocWhere = mergeWhereClauses(docWhere, args.policyWhere);
  const needsSubQueryFalse = checkNeedsSubQueryFalse(args.policyWhere);

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

  return filterByScore(mapped, config);
};
