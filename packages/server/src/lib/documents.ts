import fs from 'node:fs';
import path from 'node:path';

import createDebug from 'debug';

import { db } from '../db';
import { chunkPages, type ChunkStrategy, persistChunks } from './chunking';
import { emitEvent } from './eventBus';
import { recoverStaleDocument } from './ingestionCallback';
import { mapDocument } from './knowledge';
import { registerResourceFieldMap } from './policyCompiler';

export {
  enqueueDocumentIngestion,
  reingestDocument,
} from './documentIngestion';
export { completeIngestionCallback } from './ingestionCallback';
export type { DocumentQueryConfig, QueryDocumentResult } from './knowledge';
export { resolveDocumentSearch } from './knowledge';

const log = createDebug('soat:documents');

registerResourceFieldMap({
  resourceType: 'document',
  publicIdColumn: { column: 'publicId' },
  pathColumn: { column: 'path', alias: 'file' },
  tagsColumn: { column: 'tags' },
});

const getStorageDir = () => {
  const dir = process.env.FILES_STORAGE_DIR;
  if (!dir)
    throw new Error('FILES_STORAGE_DIR environment variable is not set');
  return dir;
};

const normalizePath = (filePath: string): string => {
  if (!filePath) return '/';
  let normalized = filePath.trim();
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized !== '/' && normalized.endsWith('/'))
    normalized = normalized.slice(0, -1);
  return normalized;
};

type LoadedDoc = InstanceType<(typeof db)['Document']> & {
  file?: InstanceType<(typeof db)['File']> & {
    project?: InstanceType<(typeof db)['Project']>;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fileAndProjectInclude = (): any[] => {
  return [
    {
      model: db.File,
      as: 'file',
      include: [{ model: db.Project, as: 'project' }],
    },
  ];
};

const fetchDocumentWithContext = (
  publicId: string
): Promise<LoadedDoc | null> => {
  return db.Document.findOne({
    where: { publicId },
    include: fileAndProjectInclude(),
  }) as Promise<LoadedDoc | null>;
};

const fetchDocumentByIdWithContext = (
  id: number
): Promise<LoadedDoc | null> => {
  return db.Document.findOne({
    where: { id },
    include: fileAndProjectInclude(),
  }) as Promise<LoadedDoc | null>;
};

const buildDocumentQueryOptions = (args: {
  projectIds?: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
  limit: number;
  offset: number;
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topLevelWhere: Record<string, any> =
    args.policyWhere && Object.keys(args.policyWhere).length > 0
      ? { ...args.policyWhere }
      : {};
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

const parseDocMetadata = (
  metadata: string | null | undefined
): Record<string, unknown> => {
  if (!metadata) return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/**
 * Compute an ingestion progress percentage (0–100) from the live chunk count
 * and the planned total. `null` when progress is not meaningful (failed, or
 * processing before the total is known). Capped at 99 while still `processing`
 * so it only reads 100 once the document is `ready`.
 */
const computeIngestionProgress = (args: {
  status: string;
  chunkCount: number;
  totalChunks?: number;
}): number | null => {
  if (args.status === 'ready') return 100;
  if (args.status === 'pending') return 0;
  if (args.status !== 'processing') return null; // failed / unknown
  if (typeof args.totalChunks !== 'number' || args.totalChunks <= 0)
    return null;
  const pct = Math.floor((args.chunkCount / args.totalChunks) * 100);
  return Math.max(0, Math.min(99, pct));
};

/**
 * Lightweight ingestion status for polling (issues #5, #6). Returns only the
 * lifecycle fields — never the (potentially multi-megabyte) chunk content that
 * `getDocument` assembles. Self-recovers a stalled document to `failed` so a
 * poller eventually sees a terminal state (issue #4).
 *
 * Field semantics, by lifecycle state:
 * - `chunk_count` — the number of chunks **currently indexed** (a live count of
 *   persisted chunks). It grows during `processing` and equals the final total
 *   once `ready`. `0` while `pending` / early `processing`.
 * - `total_chunks` — the planned number of chunks, known once chunking starts.
 *   `null` until then (e.g. early `pending`).
 * - `total_pages` — the number of source pages extracted. Only known once
 *   extraction has run, so it is `null` until the document is `ready` (or
 *   `failed`). `null` does not mean "zero pages".
 * - `progress` — `chunk_count / total_chunks` as a percentage (0–100). `0` while
 *   `pending`, climbs while `processing` (capped at 99), `100` when `ready`,
 *   `null` when `failed` or not yet computable.
 */
export const getDocumentStatus = async (args: { id: string }) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) return null;

  await recoverStaleDocument(doc);

  const metadata = parseDocMetadata(doc.metadata);
  const mapped = mapDocument(doc);

  // Always report the live count so the value is meaningful while processing,
  // not just after metadata is written on completion.
  const chunkCount = await db.DocumentChunk.count({
    where: { documentId: doc.id },
  });

  const totalChunks =
    typeof metadata.total_chunks === 'number'
      ? metadata.total_chunks
      : undefined;

  const totalPages =
    typeof metadata.total_pages === 'number' ? metadata.total_pages : null;

  const failureReason =
    typeof metadata.failure_reason === 'string'
      ? metadata.failure_reason
      : undefined;

  return {
    id: mapped.id,
    status: doc.status,
    chunkCount,
    totalChunks: totalChunks ?? null,
    totalPages,
    progress: computeIngestionProgress({
      status: doc.status,
      chunkCount,
      totalChunks,
    }),
    error: doc.status === 'failed' ? failureReason : undefined,
    // Context for the route's permission check — not part of the public
    // status response shape.
    projectId: mapped.projectId,
    path: mapped.path,
    tags: mapped.tags,
  };
};

export const getDocument = async (args: { id: string }) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) return null;

  await recoverStaleDocument(doc);

  const mapped = mapDocument(doc);

  const chunks = await db.DocumentChunk.findAll({
    where: { documentId: doc.id },
    order: [['chunkIndex', 'ASC']],
  });

  if (chunks.length > 0) {
    const content = chunks
      .map((c) => {
        return c.content;
      })
      .join('\n');
    return { ...mapped, content };
  }

  // Fallback: try reading from file for legacy documents without chunks
  if (doc.file?.storagePath && fs.existsSync(doc.file.storagePath)) {
    const content = fs.readFileSync(doc.file.storagePath, 'utf-8');
    return { ...mapped, content };
  }

  return { ...mapped, content: null };
};

/**
 * Chunk plain document text and persist the chunks. Treats the content as a
 * single source "page" and applies the requested strategy (default `whole`,
 * i.e. one chunk — the historical behavior). Lets any document creation chunk,
 * not just file ingestion.
 */
const chunkDocumentText = async (args: {
  documentId: number;
  content: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
}) => {
  const chunks = chunkPages({
    pages: [{ text: args.content }],
    strategy: args.chunkStrategy ?? 'whole',
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
  });
  await persistChunks({ documentId: args.documentId, chunks });
};

export const createDocument = async (args: {
  projectId: number;
  content: string;
  path?: string;
  filename?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
}) => {
  log('createDocument: projectId=%d', args.projectId);

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

  const doc = await db.Document.create({
    fileId: file.id,
    title: args.title ?? null,
    metadata: args.metadata ? JSON.stringify(args.metadata) : null,
    tags: args.tags ?? null,
  });

  await chunkDocumentText({
    documentId: doc.id as number,
    content: args.content,
    chunkStrategy: args.chunkStrategy,
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
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

  if (!doc) return null;

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

const updateDocumentContent = async (args: {
  doc: LoadedDoc;
  content: string;
}) => {
  if (args.doc.file?.storagePath) {
    fs.writeFileSync(args.doc.file.storagePath, args.content, 'utf-8');
    await args.doc.file.update({
      size: Buffer.byteLength(args.content, 'utf-8'),
    });
  }

  // Re-chunk: destroy existing chunks and create a single new one
  await db.DocumentChunk.destroy({ where: { documentId: args.doc.id } });

  await chunkDocumentText({
    documentId: args.doc.id as number,
    content: args.content,
  });
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

  if (!doc) return null;

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

  if (Object.keys(updates).length > 0) {
    await doc.update(updates);
  }

  const refreshed = await fetchDocumentByIdWithContext(doc.id as number);
  const mapped = mapDocument(refreshed!);

  emitDocumentLifecycleEvent({
    type: 'documents.updated',
    doc: refreshed!,
    data: mapped as unknown as Record<string, unknown>,
  });

  return mapped;
};

export const getDocumentTags = async (args: { id: string }) => {
  const doc = await db.Document.findOne({ where: { publicId: args.id } });
  if (!doc) return null;
  return doc.tags ?? {};
};

export const updateDocumentTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) return null;

  const newTags = args.merge
    ? { ...(doc.tags ?? {}), ...args.tags }
    : args.tags;

  await doc.update({ tags: newTags });

  const refreshed = await fetchDocumentByIdWithContext(doc.id as number);
  const tagsMapped = mapDocument(refreshed!);

  emitDocumentLifecycleEvent({
    type: 'documents.updated',
    doc: refreshed!,
    data: tagsMapped as unknown as Record<string, unknown>,
  });

  return tagsMapped;
};
