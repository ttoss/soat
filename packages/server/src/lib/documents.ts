import fs from 'node:fs';
import path from 'node:path';

import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { mapDocument } from './documentQuery';
import { getEmbedding } from './embedding';
import { emitEvent } from './eventBus';
import { registerResourceFieldMap } from './policyCompiler';

export type { DocumentQueryConfig, QueryDocumentResult } from './documentQuery';
export { resolveDocumentQuery } from './documentQuery';

registerResourceFieldMap({
  resourceType: 'document',
  publicIdColumn: { column: 'publicId' },
  pathColumn: { column: 'path', alias: 'file' },
  tagsColumn: { column: 'tags' },
});

const getStorageDir = () => {
  const dir = process.env.FILES_STORAGE_DIR;
  if (!dir) {
    throw new Error('FILES_STORAGE_DIR environment variable is not set');
  }
  return dir;
};

/**
 * Normalize a file path to a consistent format
 */
const normalizePath = (filePath: string): string => {
  if (!filePath) return '/';
  let normalized = filePath.trim();
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  // Collapse multiple slashes
  normalized = normalized.replace(/\/+/g, '/');
  // Remove trailing slash (except for root)
  if (normalized !== '/' && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
};

type LoadedDoc = InstanceType<(typeof db)['Document']> & {
  file?: InstanceType<(typeof db)['File']> & {
    project?: InstanceType<(typeof db)['Project']>;
  };
};

/**
 * Build the Sequelize options for document queries with policy where clause
 */
const buildDocumentQueryOptions = (args: {
  projectIds?: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
  limit: number;
  offset: number;
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topLevelWhere: Record<string, any> = {};
  if (args.policyWhere && Object.keys(args.policyWhere).length > 0) {
    Object.assign(topLevelWhere, args.policyWhere);
  }

  const fileWhere =
    args.projectIds !== undefined ? { projectId: args.projectIds } : undefined;

  const needsSubQueryFalse =
    args.policyWhere !== undefined &&
    Object.keys(args.policyWhere).some((k) => {
      return k.startsWith('$');
    });

  return {
    topLevelWhere,
    fileWhere,
    subQuery: needsSubQueryFalse ? false : undefined,
  };
};

const emitDocumentLifecycleEvent = (args: {
  type: string;
  doc: LoadedDoc;
  data: Record<string, unknown>;
}) => {
  const project = args.doc.file?.project;
  if (!project) return;
  emitEvent({
    type: args.type,
    projectId: project.id,
    projectPublicId: project.publicId,
    resourceType: 'document',
    resourceId: args.doc.publicId,
    data: args.data,
    timestamp: new Date().toISOString(),
  });
};

export const listDocuments = async (args: {
  projectIds?: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return { data: [], total: 0, limit, offset };
  }

  const { topLevelWhere, fileWhere, subQuery } = buildDocumentQueryOptions({
    projectIds: args.projectIds,
    policyWhere: args.policyWhere,
    limit,
    offset,
  });

  const { count, rows } = await db.Document.findAndCountAll({
    distinct: true,
    where: Object.keys(topLevelWhere).length > 0 ? topLevelWhere : undefined,
    include: [
      {
        model: db.File,
        as: 'file',
        where: fileWhere,
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
    subQuery,
    limit,
    offset,
  });
  return { data: rows.map(mapDocument), total: count, limit, offset };
};

/**
 * Fetch a document by public ID with full file and project context
 */
const fetchDocumentWithContext = async (
  publicId: string
): Promise<LoadedDoc | null> => {
  return db.Document.findOne({
    where: { publicId },
    include: [
      {
        model: db.File,
        as: 'file',
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
  });
};

/**
 * Fetch a document by ID with full file and project context
 */
const fetchDocumentByIdWithContext = async (
  id: number
): Promise<LoadedDoc | null> => {
  return db.Document.findOne({
    where: { id },
    include: [
      {
        model: db.File,
        as: 'file',
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
  });
};

export const getDocument = async (args: { id: string }) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) {
    return null;
  }

  const mapped = mapDocument(doc);

  if (doc.file?.storagePath && fs.existsSync(doc.file.storagePath)) {
    const content = fs.readFileSync(doc.file.storagePath, 'utf-8');
    return { ...mapped, content };
  }

  return { ...mapped, content: null };
};

/**
 * Update document content and file size/embedding
 */
const updateDocumentContent = async (args: {
  doc: LoadedDoc;
  content: string;
}) => {
  if (args.doc.file?.storagePath) {
    fs.writeFileSync(args.doc.file.storagePath, args.content, 'utf-8');
    await args.doc.file.update({
      size: Buffer.byteLength(args.content, 'utf-8'),
    });
    const embedding = await getEmbedding({ text: args.content });
    await args.doc.update({ embedding });
  }
};

/**
 * Update document metadata, title, and tags
 */
const updateDocumentMetadata = async (args: {
  doc: LoadedDoc;
  updates: Record<string, unknown>;
}) => {
  if (Object.keys(args.updates).length > 0) {
    await args.doc.update(args.updates);
  }
};

export const createDocument = async (args: {
  projectId: number;
  content: string;
  path?: string;
  filename?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}) => {
  const storageDir = getStorageDir();
  fs.mkdirSync(storageDir, { recursive: true });

  const effectivePath = args.path ?? args.filename ?? null;
  const file = await db.File.create({
    projectId: args.projectId,
    path: effectivePath,
    filename: args.filename ?? 'document.txt',
    contentType: 'text/plain',
    size: Buffer.byteLength(args.content, 'utf-8'),
    storageType: 'local' as const,
    storagePath: '',
  });

  const storagePath = path.join(storageDir, `${file.publicId}.txt`);
  fs.writeFileSync(storagePath, args.content, 'utf-8');
  await file.update({
    storagePath,
    size: Buffer.byteLength(args.content, 'utf-8'),
  });

  const embedding = await getEmbedding({ text: args.content });

  const doc = await db.Document.create({
    fileId: file.id,
    embedding,
    title: args.title ?? null,
    metadata: args.metadata ? JSON.stringify(args.metadata) : null,
    tags: args.tags ?? null,
  });

  const created = await fetchDocumentByIdWithContext(doc.id as number);

  const mapped = mapDocument(created!);

  emitDocumentLifecycleEvent({
    type: 'documents.created',
    doc: created!,
    data: mapped as unknown as Record<string, unknown>,
  });

  return mapped;
};

export const deleteDocument = async (args: { id: string }) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) {
    return null;
  }

  const storagePath = doc.file?.storagePath;
  if (storagePath) {
    try {
      fs.unlinkSync(storagePath);
    } catch {
      // Ignore missing file errors
    }
  }

  const docPublicId = doc.publicId;
  await doc.destroy();
  if (doc.file) {
    await doc.file.destroy();
  }

  emitDocumentLifecycleEvent({
    type: 'documents.deleted',
    doc,
    data: { id: docPublicId },
  });

  return true;
};

export const updateDocument = async (args: {
  id: string;
  content?: string;
  title?: string;
  path?: string | null;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) {
    return null;
  }

  if (args.content !== undefined) {
    await updateDocumentContent({ doc, content: args.content });
  }

  if (args.path !== undefined && doc.file) {
    const normalizedPath = args.path === null ? null : normalizePath(args.path);
    await doc.file.update({ path: normalizedPath });
  }

  const updates: Record<string, unknown> = {};
  if (args.title !== undefined) updates.title = args.title;
  if (args.metadata !== undefined)
    updates.metadata = JSON.stringify(args.metadata);
  if (args.tags !== undefined) updates.tags = args.tags;

  await updateDocumentMetadata({ doc, updates });

  const refreshed = await fetchDocumentByIdWithContext(doc.id as number);

  const mapped = mapDocument(refreshed!);

  emitDocumentLifecycleEvent({
    type: 'documents.updated',
    doc: refreshed!,
    data: mapped as unknown as Record<string, unknown>,
  });

  return mapped;
};

/**
 * Build Sequelize query options for document search
 */
const buildSearchQueryOptions = (args: {
  projectIds?: number[];
  tags?: Record<string, string>;
}) => {
  const fileWhere =
    args.projectIds !== undefined ? { projectId: args.projectIds } : undefined;

  const docWhere: Record<string, unknown> =
    args.tags && Object.keys(args.tags).length > 0
      ? { tags: { [Op.contains]: args.tags } }
      : {};

  return { fileWhere, docWhere };
};

/**
 * Map database document to result with score
 */
const mapSearchResult = (doc: InstanceType<(typeof db)['Document']>) => {
  const distance = parseFloat((doc.getDataValue('distance') as string) ?? '1');
  const score = 1 - distance;
  const mapped = mapDocument(doc);

  let content: string | null = null;
  if (doc.file?.storagePath && fs.existsSync(doc.file.storagePath)) {
    content = fs.readFileSync(doc.file.storagePath, 'utf-8');
  }

  return { ...mapped, content, score };
};

export const searchDocuments = async (args: {
  projectIds?: number[];
  query: string;
  limit?: number;
  threshold?: number;
  tags?: Record<string, string>;
}) => {
  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return [];
  }

  const embedding = await getEmbedding({ text: args.query });
  const limit = args.limit ?? 10;
  const embeddingLiteral = `[${embedding.join(',')}]`;

  const { fileWhere, docWhere } = buildSearchQueryOptions({
    projectIds: args.projectIds,
    tags: args.tags,
  });

  const documents = await db.Document.findAll({
    where: docWhere,
    attributes: {
      include: [
        [
          db.Document.sequelize!.literal(`embedding <=> '${embeddingLiteral}'`),
          'distance',
        ],
      ],
    },
    include: [
      {
        model: db.File,
        as: 'file',
        where: fileWhere,
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
    order: db.Document.sequelize!.literal(
      `embedding <=> '${embeddingLiteral}'`
    ),
    limit,
  });

  return documents
    .map((doc: InstanceType<(typeof db)['Document']>) => {
      return mapSearchResult(doc);
    })
    .filter((doc: { score: number }) => {
      return args.threshold === undefined || doc.score >= args.threshold;
    });
};

export const getDocumentTags = async (args: { id: string }) => {
  const doc = await db.Document.findOne({ where: { publicId: args.id } });

  if (!doc) {
    return null;
  }

  return doc.tags ?? {};
};

/**
 * Merge or replace document tags and emit lifecycle event
 */
const updateAndEmitTags = async (args: {
  doc: LoadedDoc;
  newTags: Record<string, string>;
}) => {
  await args.doc.update({ tags: args.newTags });

  const refreshed = await fetchDocumentByIdWithContext(args.doc.id as number);

  const tagsMapped = mapDocument(refreshed!);

  emitDocumentLifecycleEvent({
    type: 'documents.updated',
    doc: refreshed!,
    data: tagsMapped as unknown as Record<string, unknown>,
  });

  return tagsMapped;
};

export const updateDocumentTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) {
    return null;
  }

  const newTags = args.merge
    ? { ...(doc.tags ?? {}), ...args.tags }
    : args.tags;

  return updateAndEmitTags({ doc, newTags });
};
