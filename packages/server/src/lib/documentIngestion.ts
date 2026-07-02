import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { chunkPages, type ChunkStrategy, persistChunks } from './chunking';
import { emitEvent } from './eventBus';
import { resolveIngestionRule } from './ingestionRules';
import { mapDocument } from './knowledge';
import {
  type ResolvedSourcePages,
  resolveSourcePages,
  SUPPORTED_CONTENT_TYPES,
} from './sourcePageResolver';

const log = createDebug('soat:documents');

// Files larger than this cannot be ingested synchronously (`?async=false`):
// parsing + embedding a large file blocks the request long enough to time out
// behind most proxies. Configurable via SYNC_INGESTION_MAX_BYTES.
const SYNC_INGESTION_DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// A document left in `pending`/`processing` with no progress for longer than
// this is considered abandoned (e.g. the process crashed mid-ingestion) and is
// marked `failed` on the next read so callers can recover. Configurable via
// INGESTION_STALL_TIMEOUT_MS.
const INGESTION_STALL_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const getSyncIngestionMaxBytes = (): number => {
  const raw = process.env.SYNC_INGESTION_MAX_BYTES;
  if (!raw) return SYNC_INGESTION_DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SYNC_INGESTION_DEFAULT_MAX_BYTES;
};

const getStallTimeoutMs = (): number => {
  const raw = process.env.INGESTION_STALL_TIMEOUT_MS;
  if (!raw) return INGESTION_STALL_DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : INGESTION_STALL_DEFAULT_TIMEOUT_MS;
};

/**
 * Normalize a thrown value into a stable, human-readable failure reason.
 * Without this, a non-Error rejection serializes to the useless string
 * `"[object Object]"` (issue #3).
 */
const describeError = (error: unknown): string => {
  if (error instanceof DomainError) return error.code;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'INGESTION_FAILED';
};

const assertSyncIngestible = (
  file: InstanceType<(typeof db)['File']>
): void => {
  const max = getSyncIngestionMaxBytes();
  const size = file.size ?? 0;
  if (size > max) {
    throw new DomainError(
      'FILE_TOO_LARGE_FOR_SYNC',
      `File is ${size} bytes, which exceeds the ${max}-byte synchronous ingestion limit. Retry in async mode (omit ?async=false) and poll GET /documents/{id}/status.`
    );
  }
};

type IngestedDoc = InstanceType<(typeof db)['Document']> & {
  file?: InstanceType<(typeof db)['File']> & {
    project?: InstanceType<(typeof db)['Project']>;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fileProjectInclude = (): any[] => {
  return [
    {
      model: db.File,
      as: 'file',
      include: [{ model: db.Project, as: 'project' }],
    },
  ];
};

const fetchIngestedDocById = (id: number): Promise<IngestedDoc | null> => {
  return db.Document.findOne({
    where: { id },
    include: fileProjectInclude(),
  }) as Promise<IngestedDoc | null>;
};

/**
 * Admission gate shared by first-time ingestion and re-ingestion: a content
 * type is ingestible either natively (SUPPORTED_CONTENT_TYPES) or via a
 * matching project IngestionRule (converter). Keeping this in one place means
 * a document ingested through a converter rule can always be re-ingested the
 * same way.
 */
const assertFileTypeIngestible = async (args: {
  fileId: string;
  projectId: number;
  contentType: string | null | undefined;
}): Promise<void> => {
  if (SUPPORTED_CONTENT_TYPES.includes(args.contentType ?? '')) return;

  const rule = await resolveIngestionRule({
    projectId: args.projectId,
    contentType: args.contentType ?? '',
  });
  if (!rule) {
    throw new DomainError(
      'UNSUPPORTED_FILE_TYPE',
      `File '${args.fileId}' has unsupported content type '${args.contentType ?? 'unknown'}' and no matching ingestion rule. Natively supported: ${SUPPORTED_CONTENT_TYPES.join(', ')}.`
    );
  }
};

const loadIngestibleFile = async (fileId: string) => {
  const file = await db.File.findOne({
    where: { publicId: fileId },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!file) {
    throw new DomainError('FILE_NOT_FOUND', `File '${fileId}' not found.`);
  }

  await assertFileTypeIngestible({
    fileId,
    projectId: file.projectId,
    contentType: file.contentType,
  });

  return file;
};

type IngestionPipelineArgs = {
  doc: InstanceType<(typeof db)['Document']>;
  fileId: string;
  docPath: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
};

/**
 * Persist chunks while keeping the document's progress metadata current.
 * Records the totals up front (so the status endpoint has a denominator) and
 * periodically rewrites `indexed_chunks`, which also bumps `updatedAt` to keep
 * a long-running ingestion from looking stalled (issue #4).
 */
const persistChunksWithProgress = async (args: {
  doc: InstanceType<(typeof db)['Document']>;
  docId: number;
  fileId: string;
  totalPages: number;
  chunks: { content: string; chunkIndex: number; pageNumber?: number }[];
}): Promise<void> => {
  const writeProgress = (indexed: number) => {
    return args.doc.update({
      metadata: JSON.stringify({
        source_file_id: args.fileId,
        total_pages: args.totalPages,
        total_chunks: args.chunks.length,
        indexed_chunks: indexed,
      }),
    });
  };

  await writeProgress(0);

  let lastTouch = Date.now();
  await persistChunks({
    documentId: args.docId,
    chunks: args.chunks,
    onProgress: async (indexed) => {
      const now = Date.now();
      if (now - lastTouch < 10_000 && indexed < args.chunks.length) return;
      lastTouch = now;
      await writeProgress(indexed);
    },
  });
};

// Per-request chunk config wins; otherwise fall back to the converter rule's
// defaults, then to the pipeline default.
const resolveChunkConfig = (
  args: IngestionPipelineArgs,
  rule: ResolvedSourcePages['rule']
): { strategy: ChunkStrategy; chunkSize?: number; chunkOverlap?: number } => {
  const strategy = args.chunkStrategy ?? rule?.chunkStrategy ?? 'page';
  return {
    strategy: strategy as ChunkStrategy,
    chunkSize: args.chunkSize ?? rule?.chunkSize ?? undefined,
    chunkOverlap: args.chunkOverlap ?? rule?.chunkOverlap ?? undefined,
  };
};

const runIngestionPipeline = async (args: IngestionPipelineArgs) => {
  const { doc } = args;
  const docId = doc.id as number;

  const file = (await db.File.findByPk(doc.fileId, {
    include: [{ model: db.Project, as: 'project' }],
  })) as
    | (InstanceType<(typeof db)['File']> & {
        project?: InstanceType<(typeof db)['Project']>;
      })
    | null;

  if (!file) {
    await doc.update({
      status: 'failed',
      metadata: JSON.stringify({
        source_file_id: args.fileId,
        failure_reason: 'FILE_NOT_FOUND',
      }),
    });
    return;
  }

  const { pages, rule } = await resolveSourcePages(file);

  if (pages.length === 0) {
    await doc.update({
      status: 'failed',
      metadata: JSON.stringify({
        source_file_id: args.fileId,
        failure_reason: 'FILE_PARSE_FAILED',
      }),
    });
    log('runIngestionPipeline: no extractable text docId=%d', docId);
    return;
  }

  const chunks = chunkPages({ pages, ...resolveChunkConfig(args, rule) });

  await persistChunksWithProgress({
    doc,
    docId,
    fileId: args.fileId,
    totalPages: pages.length,
    chunks,
  });

  await file.update({ path: args.docPath });
  await doc.update({
    status: 'ready',
    metadata: JSON.stringify({
      source_file_id: args.fileId,
      total_pages: pages.length,
      total_chunks: chunks.length,
      chunk_count: chunks.length,
    }),
  });

  log('runIngestionPipeline: ready docId=%d chunks=%d', docId, chunks.length);

  const fetched = await fetchIngestedDocById(docId);
  const project = fetched?.file?.project;
  if (fetched && project) {
    emitEvent({
      type: 'documents.created',
      projectId: project.id,
      projectPublicId: project.publicId,
      resourceType: 'document',
      resourceId: fetched.publicId,
      data: {
        ...(mapDocument(fetched) as unknown as Record<string, unknown>),
        chunkCount: chunks.length,
      },
      timestamp: new Date().toISOString(),
    });
  }
};

const processDocumentIngestion = async (args: {
  docId: number;
  fileId: string;
  docPath: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
}): Promise<void> => {
  log('processDocumentIngestion: docId=%d fileId=%s', args.docId, args.fileId);

  const doc = await db.Document.findByPk(args.docId);
  if (!doc) return;

  await doc.update({ status: 'processing' });

  try {
    await runIngestionPipeline({ doc, ...args });
  } catch (error) {
    log(
      'processDocumentIngestion: failed docId=%d error=%o',
      args.docId,
      error
    );
    try {
      await doc.update({
        status: 'failed',
        metadata: JSON.stringify({
          source_file_id: args.fileId,
          failure_reason: describeError(error),
        }),
      });
    } catch {
      // ignore secondary failure
    }
  }
};

/**
 * Validate the file and create a Document record. When `async` is true
 * (default) processing is deferred to the next event loop tick and the
 * document is returned with `status=pending` (HTTP 202). When `async` is
 * false the pipeline runs synchronously and the document is returned with
 * `status=ready` (HTTP 201).
 */
export const enqueueDocumentIngestion = async (args: {
  fileId: string;
  projectId: number;
  pathPrefix?: string;
  tags?: Record<string, string>;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
  async?: boolean;
}) => {
  const runAsync = args.async !== false;

  log(
    'enqueueDocumentIngestion: fileId=%s projectId=%d strategy=%s async=%s',
    args.fileId,
    args.projectId,
    args.chunkStrategy ?? 'page',
    runAsync
  );

  const file = await loadIngestibleFile(args.fileId);

  if (!runAsync) {
    assertSyncIngestible(file);
  }

  const filename = file.filename ?? 'document';
  const docPath = args.pathPrefix
    ? `${args.pathPrefix.replace(/\/$/, '')}/${filename}`
    : `/${filename}`;

  const doc = await db.Document.create({
    fileId: file.id,
    title: filename,
    status: 'pending',
    metadata: JSON.stringify({ source_file_id: args.fileId }),
    tags: args.tags ?? null,
  });

  const docId = doc.id as number;
  const pipelineArgs = {
    docId,
    fileId: args.fileId,
    docPath,
    chunkStrategy: args.chunkStrategy,
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
  };

  if (runAsync) {
    setImmediate(() => {
      void processDocumentIngestion(pipelineArgs);
    });
  } else {
    await processDocumentIngestion(pipelineArgs);
  }

  const fetched = await fetchIngestedDocById(docId);
  return mapDocument(fetched!);
};

/**
 * True when a document is in a non-terminal ingestion state (`pending` or
 * `processing`) but has not been touched within the stall timeout — i.e. the
 * ingestion was abandoned (issue #4).
 */
export const isIngestionStale = (
  doc: InstanceType<(typeof db)['Document']>
): boolean => {
  if (doc.status !== 'pending' && doc.status !== 'processing') return false;
  const updatedAt = doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
  return Date.now() - updatedAt > getStallTimeoutMs();
};

/**
 * If a document's ingestion has stalled, transition it to `failed` with a
 * `INGESTION_TIMEOUT` reason so callers get a terminal state to act on instead
 * of polling forever. Mutates `doc` in place and returns whether it recovered.
 */
export const recoverStaleDocument = async (
  doc: InstanceType<(typeof db)['Document']>
): Promise<boolean> => {
  if (!isIngestionStale(doc)) return false;

  let meta: Record<string, unknown> = {};
  try {
    meta = doc.metadata ? JSON.parse(doc.metadata) : {};
  } catch {
    meta = {};
  }

  await doc.update({
    status: 'failed',
    metadata: JSON.stringify({ ...meta, failure_reason: 'INGESTION_TIMEOUT' }),
  });
  log(
    'recoverStaleDocument: marked stalled ingestion failed id=%s',
    doc.publicId
  );
  return true;
};

const ensureReingestibleFile = async (args: {
  id: string;
  file?: IngestedDoc['file'];
}): Promise<NonNullable<IngestedDoc['file']>> => {
  const { file } = args;
  if (!file) {
    throw new DomainError(
      'FILE_NOT_FOUND',
      `Document '${args.id}' has no underlying file to re-ingest.`
    );
  }

  await assertFileTypeIngestible({
    fileId: file.publicId,
    projectId: file.projectId,
    contentType: file.contentType,
  });

  return file;
};

/**
 * Re-run ingestion for an existing document against its already-stored source
 * file (issue #7). Clears the existing chunks, resets the document to
 * `pending`, then runs the same pipeline as the initial ingestion. Useful to
 * recover a stuck document or re-process with a different chunk strategy.
 * Returns `null` when the document does not exist.
 */
export const reingestDocument = async (args: {
  id: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
  async?: boolean;
}) => {
  const doc = (await db.Document.findOne({
    where: { publicId: args.id },
    include: fileProjectInclude(),
  })) as IngestedDoc | null;

  if (!doc) return null;

  const file = await ensureReingestibleFile({ id: args.id, file: doc.file });

  const runAsync = args.async !== false;
  if (!runAsync) {
    assertSyncIngestible(file);
  }

  log(
    'reingestDocument: id=%s async=%s strategy=%s',
    args.id,
    runAsync,
    args.chunkStrategy ?? 'page'
  );

  const docId = doc.id as number;

  // Start from a clean slate so re-processing does not accumulate chunks.
  await db.DocumentChunk.destroy({ where: { documentId: docId } });
  await doc.update({
    status: 'pending',
    metadata: JSON.stringify({ source_file_id: file.publicId }),
  });

  const docPath = file.path ?? `/${file.filename ?? 'document'}`;
  const pipelineArgs = {
    docId,
    fileId: file.publicId,
    docPath,
    chunkStrategy: args.chunkStrategy,
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
  };

  if (runAsync) {
    setImmediate(() => {
      void processDocumentIngestion(pipelineArgs);
    });
  } else {
    await processDocumentIngestion(pipelineArgs);
  }

  const fetched = await fetchIngestedDocById(docId);
  return mapDocument(fetched!);
};
