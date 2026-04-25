import fs from 'node:fs';

import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { getEmbedding } from './embedding';
import { buildSrn, evaluatePolicies, type PolicyDocument } from './iam';

// ── Shared document mapper ───────────────────────────────────────────────

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
    filename: doc.file?.filename,
    size: doc.file?.size,
    title: doc.title ?? undefined,
    metadata: doc.metadata
      ? (() => {
          try {
            return JSON.parse(doc.metadata!);
          } catch {
            return doc.metadata;
          }
        })()
      : undefined,
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
        return { filename: { [Op.like]: `${p}%` } };
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

const applyBoundaryFilter = (
  docs: QueryDocumentResult[],
  policy: PolicyDocument
) => {
  return docs.filter((doc) => {
    if (!doc.projectId) return false;
    const srn = buildSrn({
      projectPublicId: doc.projectId,
      resourceType: 'document',
      resourceId: doc.id,
    });
    return evaluatePolicies({
      policies: [policy],
      action: 'documents:SearchDocuments',
      resource: srn,
    });
  });
};

// ── Query engine ─────────────────────────────────────────────────────────

/**
 * Core document search engine used by the documents search endpoint and the
 * memories module. Applies three access-scoping layers:
 *
 * 1. Caller permissions  — `projectIds` scope (resolved via `resolveProjectIds`)
 * 2. Agent boundary policy — optional SRN-level resource filtering per document
 * 3. Config filters        — search, paths, documentIds, minScore, limit
 *
 * At least one of `search`, `paths`, or `documentIds` must be set in config.
 */
export const resolveDocumentQuery = async (args: {
  projectIds?: number[];
  config: DocumentQueryConfig;
  boundaryPolicy?: unknown;
}): Promise<QueryDocumentResult[]> => {
  const { config, projectIds } = args;
  const limit = config.limit ?? 10;

  if (projectIds !== undefined && projectIds.length === 0) {
    return [];
  }

  const fileInclude = buildFileInclude({ projectIds, paths: config.paths });
  const docWhere = buildDocWhere(config.documentIds);

  let rawDocuments: Array<InstanceType<(typeof db)['Document']>>;

  if (config.search) {
    const embedding = await getEmbedding({ text: config.search });
    const embeddingLiteral = `[${embedding.join(',')}]`;
    rawDocuments = await db.Document.findAll({
      where: docWhere,
      attributes: {
        include: [
          [
            db.Document.sequelize!.literal(
              `embedding <=> '${embeddingLiteral}'`
            ),
            'distance',
          ],
        ],
      },
      include: [fileInclude],
      order: db.Document.sequelize!.literal(
        `embedding <=> '${embeddingLiteral}'`
      ),
      limit,
    });
  } else {
    rawDocuments = await db.Document.findAll({
      where: docWhere,
      include: [fileInclude],
      order: [['createdAt', 'ASC']],
      limit,
    });
  }

  const mapped = rawDocuments.map((doc) => {
    return mapRawDocument(doc, config);
  });

  const scored =
    config.search && config.minScore !== undefined
      ? mapped.filter((doc) => {
          return (
            (doc as { score?: number }).score !== undefined &&
            (doc as { score?: number }).score! >= config.minScore!
          );
        })
      : mapped;

  if (!args.boundaryPolicy) {
    return scored as QueryDocumentResult[];
  }

  return applyBoundaryFilter(
    scored as QueryDocumentResult[],
    args.boundaryPolicy as PolicyDocument
  );
};
