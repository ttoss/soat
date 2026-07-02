import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { ChunkStrategy } from './chunking';
import {
  type ChunkConfigInput,
  fetchIngestedDocById,
  fileProjectInclude,
  finalizeIngestedPages,
  type IngestedDoc,
  resolveChunkConfig,
} from './documentIngestionCore';
import { resolveIngestionRule } from './ingestionRules';
import { mapDocument } from './knowledge';
import {
  resolveSourcePages,
  SUPPORTED_CONTENT_TYPES,
} from './sourcePageResolver';

export {
  finalizeIngestedPages,
  parseDocMetadata,
} from './documentIngestionCore';

const log = createDebug('soat:documents');

// Files larger than this cannot be ingested synchronously (`?async=false`):
// parsing + embedding a large file blocks the request long enough to time out
// behind most proxies. Configurable via SYNC_INGESTION_MAX_BYTES.
const SYNC_INGESTION_DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const getSyncIngestionMaxBytes = (): number => {
  const raw = process.env.SYNC_INGESTION_MAX_BYTES;
  if (!raw) return SYNC_INGESTION_DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SYNC_INGESTION_DEFAULT_MAX_BYTES;
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

type IngestionPipelineArgs = ChunkConfigInput & {
  doc: InstanceType<(typeof db)['Document']>;
  attemptId: string;
  fileId: string;
  docPath: string;
  isAsync: boolean;
};

const runIngestionPipeline = async (args: IngestionPipelineArgs) => {
  const { doc, attemptId } = args;
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

  const resolved = await resolveSourcePages(file, doc.publicId, attemptId);

  if (resolved.status === 'pending') {
    if (!args.isAsync) {
      // Synchronous ingestion (?async=false) cannot wait for a callback that
      // may arrive arbitrarily later — the converter must respond inline.
      throw new DomainError(
        'CONVERTER_FAILED',
        `Converter '${resolved.converterId}' deferred with { status: "pending" }, which synchronous ingestion (?async=false) cannot wait for. Retry without ?async=false.`
      );
    }

    const chunkConfig = resolveChunkConfig(args, resolved.rule);
    await doc.update({
      conversionAttemptId: attemptId,
      metadata: JSON.stringify({
        source_file_id: args.fileId,
        doc_path: args.docPath,
        conversion: {
          converter_id: resolved.converterId,
          attempt_id: attemptId,
          submitted_at: resolved.submittedAt,
          chunk_strategy: chunkConfig.strategy,
          chunk_size: chunkConfig.chunkSize ?? null,
          chunk_overlap: chunkConfig.chunkOverlap ?? null,
        },
      }),
    });
    log(
      'runIngestionPipeline: awaiting async conversion docId=%d attemptId=%s',
      docId,
      attemptId
    );
    return;
  }

  await finalizeIngestedPages({
    doc,
    docId,
    fileId: args.fileId,
    docPath: args.docPath,
    pages: resolved.pages,
    rule: resolved.rule,
    chunkStrategy: args.chunkStrategy,
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
  });
};

const processDocumentIngestion = async (args: {
  docId: number;
  fileId: string;
  docPath: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
  isAsync: boolean;
}): Promise<void> => {
  log('processDocumentIngestion: docId=%d fileId=%s', args.docId, args.fileId);

  const doc = await db.Document.findByPk(args.docId);
  if (!doc) return;

  await doc.update({ status: 'processing' });

  const attemptId = generatePublicId(PUBLIC_ID_PREFIXES.ingestionAttempt);

  try {
    await runIngestionPipeline({ doc, attemptId, ...args });
  } catch (error) {
    log(
      'processDocumentIngestion: failed docId=%d error=%o',
      args.docId,
      error
    );
    try {
      await doc.update({
        status: 'failed',
        conversionAttemptId: null,
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
    isAsync: runAsync,
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
    conversionAttemptId: null,
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
    isAsync: runAsync,
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
