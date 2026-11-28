import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { ChunkStrategy } from './chunking';
import { withoutContentBoundTags } from './contentBoundTags';
import { assertCorpusWriteQuotas } from './corpusWriteQuotas';
import { DOCUMENT_FAILURES, ingestionFailure } from './documentFailures';
import {
  type ChunkConfigInput,
  emitIngestFailed,
  fetchIngestedDocById,
  fileProjectInclude,
  finalizeIngestedPages,
  type IngestedDoc,
  resolveChunkConfig,
} from './documentIngestionCore';
import { ingestedDocumentPath, sourceFilename } from './documentIngestPath';
import { countIndexedChunks } from './documentLoaders';
import { mapDocument } from './documentMapper';
import {
  askEmbeddingWrite,
  type EmbeddingWriteAsk,
} from './embeddingAdmission';
import { assertIngestible } from './fileLifetime';
import { assertFilePathFree } from './filePathConflict';
import {
  assertCallerEndUser,
  type GenerationEndUser,
} from './generationAttribution';
import { resolveIngestionRule } from './ingestionRules';
import { loggableError } from './loggableError';
import { principalOfAuthority } from './principals';
import {
  resolveSourcePages,
  SUPPORTED_CONTENT_TYPES,
} from './sourcePageResolver';
import { isUniqueViolation } from './uniqueViolation';
import type { WorkAuthority } from './workAuthority';

export { finalizeIngestedPages } from './documentIngestionCore';

const log = createDebug('soat:documents');

// Files larger than this cannot be ingested synchronously (`?wait=true`):
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

const assertSyncIngestible = (
  file: InstanceType<(typeof db)['File']>
): void => {
  const max = getSyncIngestionMaxBytes();
  const size = file.size ?? 0;
  if (size > max) {
    throw new DomainError(
      'FILE_TOO_LARGE_FOR_SYNC',
      `File is ${size} bytes, which exceeds the ${max}-byte synchronous ingestion limit.`
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
  assertIngestible(file);

  await assertFileTypeIngestible({
    fileId,
    projectId: file.projectId,
    contentType: file.contentType,
  });

  return file;
};

const createDocumentOrThrowConflict = async (args: {
  file: InstanceType<(typeof db)['File']>;
  fileId: string;
  filename: string;
  tags?: Record<string, string>;
}) => {
  try {
    return await db.Document.create({
      fileId: args.file.id,
      title: args.filename,
      status: 'pending',
      tags: args.tags ?? null,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await db.Document.findOne({
        where: { fileId: args.file.id },
      });
      throw new DomainError(
        'FILE_ALREADY_INGESTED',
        `File '${args.fileId}' already backs Document '${existing?.publicId}'.`,
        { file_id: args.fileId, document_id: existing?.publicId }
      );
    }
    throw error;
  }
};

type IngestionPipelineArgs = ChunkConfigInput & {
  doc: InstanceType<(typeof db)['Document']>;
  attemptId: string;
  fileId: string;
  docPath: string;
  isAsync: boolean;
  endUser: GenerationEndUser;
  /** The ingest request's authority, which the converter runs under. */
  authority: WorkAuthority | null;
  ask: EmbeddingWriteAsk;
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
      error: DOCUMENT_FAILURES.FILE_NOT_FOUND,
    });
    await emitIngestFailed({ docId, error: DOCUMENT_FAILURES.FILE_NOT_FOUND });
    return;
  }

  const resolved = await resolveSourcePages(file, {
    documentId: doc.publicId,
    attemptId,
    endUser: args.endUser,
    authority: args.authority,
  });

  if (resolved.status === 'pending') {
    if (!args.isAsync) {
      // Synchronous ingestion (?wait=true) cannot wait for a callback that
      // may arrive arbitrarily later — the converter must respond inline.
      throw new DomainError(
        'CONVERTER_FAILED',
        `Converter '${resolved.converterId}' deferred with { status: "pending" }, which synchronous ingestion (?wait=true) cannot wait for.`
      );
    }

    // Written now because the callback reads them back before
    // `finalizeIngestedPages` rewrites them with the same values.
    const chunkConfig = resolveChunkConfig(args, resolved.rule);
    await doc.update({
      conversionAttemptId: attemptId,
      pendingDocPath: args.docPath,
      pendingSessionId: args.endUser.sessionId ?? null,
      pendingActorId: args.endUser.actorId ?? null,
      chunkStrategy: chunkConfig.strategy,
      chunkSize: chunkConfig.chunkSize ?? null,
      chunkOverlap: chunkConfig.chunkOverlap ?? null,
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
    projectId: file.projectId,
    docPath: args.docPath,
    pages: resolved.pages,
    rule: resolved.rule,
    chunkStrategy: args.chunkStrategy,
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
    endUser: args.endUser,
    ask: args.ask,
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
  endUser: GenerationEndUser;
  /** The ingest request's authority, which the converter runs under. */
  authority: WorkAuthority | null;
  /** Asked when the ingest was enqueued, before its document was written. */
  ask: EmbeddingWriteAsk;
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
      loggableError(error)
    );
    try {
      const failure = ingestionFailure(error);
      await doc.update({
        status: 'failed',
        conversionAttemptId: null,
        pendingDocPath: null,
        error: failure,
      });
      await emitIngestFailed({ docId: args.docId, error: failure });
    } catch {
      // ignore secondary failure
    }
  }
};

/** An ingest answer: the document plus the chunks indexed so far. */
const toIngestedRecord = async (args: { docId: number }) => {
  const fetched = await fetchIngestedDocById(args.docId);
  return {
    ...mapDocument(fetched!),
    chunk_count: await countIndexedChunks({ documentId: args.docId }),
  };
};

/**
 * The background run moves the document to `processing` as soon as it starts,
 * so its `202` answer is read before the run is scheduled.
 */
const startDocumentIngestion = async (args: {
  pipelineArgs: Parameters<typeof processDocumentIngestion>[0];
  runAsync: boolean;
}) => {
  const { pipelineArgs } = args;
  if (!args.runAsync) {
    await processDocumentIngestion(pipelineArgs);
    return toIngestedRecord({ docId: pipelineArgs.docId });
  }
  const answer = await toIngestedRecord({ docId: pipelineArgs.docId });
  setImmediate(() => {
    void processDocumentIngestion(pipelineArgs);
  });
  return answer;
};

/**
 * Validate the file and create a Document record. When `wait` is false
 * (default) processing is deferred to the next event loop tick and the
 * document is returned with `status=pending` (HTTP 202). When `wait` is
 * true the pipeline runs synchronously and the document is returned with
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
  wait?: boolean;
  /** Who the ingest runs for, validated by the route (`assertCallerEndUser`). */
  endUser: GenerationEndUser;
  /** The ingest request's authority, which the converter runs under. */
  authority: WorkAuthority | null;
}) => {
  const runAsync = args.wait !== true;

  await assertCallerEndUser({ ...args.endUser, projectId: args.projectId });

  log(
    'enqueueDocumentIngestion: fileId=%s projectId=%d strategy=%s wait=%s',
    args.fileId,
    args.projectId,
    args.chunkStrategy ?? 'page',
    !runAsync
  );

  const file = await loadIngestibleFile(args.fileId);

  if (!runAsync) {
    assertSyncIngestible(file);
  }

  // No delta: the source file is already stored and already measured. What
  // ingestion adds is chunk text and vectors, produced after this answer and
  // measured by the next snapshot — so the refusal is on the footprint as last
  // measured, which is what stops an over-cap project from indexing more.
  await assertCorpusWriteQuotas({ projectId: args.projectId, addedBytes: 0 });
  const ask = await askEmbeddingWrite({
    projectId: args.projectId,
    principal: principalOfAuthority(args.authority),
    work: 'The document ingest',
  });

  const filename = sourceFilename(file);
  const docPath = ingestedDocumentPath({
    pathPrefix: args.pathPrefix,
    filename,
  });

  // Filed only once the source converts, which may be long after this answer:
  // a path taken now is refused now rather than as a failed document later.
  await assertFilePathFree({
    projectId: file.projectId,
    path: docPath,
    exceptFileId: file.id as number,
  });

  const doc = await createDocumentOrThrowConflict({
    file,
    fileId: args.fileId,
    filename,
    tags: args.tags,
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
    endUser: args.endUser,
    authority: args.authority,
    ask,
  };

  return startDocumentIngestion({ pipelineArgs, runAsync });
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
 * file. Clears the existing chunks, resets the document to
 * `pending`, then runs the same pipeline as the initial ingestion. Useful to
 * recover a stuck document or re-process with a different chunk strategy.
 * Returns `null` when the document does not exist.
 */
export const reingestDocument = async (args: {
  id: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
  wait?: boolean;
  /** Who the re-ingest runs for, validated by the route. */
  endUser: GenerationEndUser;
  /** The ingest request's authority, which the converter runs under. */
  authority: WorkAuthority | null;
}) => {
  const doc = (await db.Document.findOne({
    where: { publicId: args.id },
    include: fileProjectInclude(),
  })) as IngestedDoc | null;

  if (!doc) return null;

  const file = await ensureReingestibleFile({ id: args.id, file: doc.file });
  await assertCallerEndUser({ ...args.endUser, projectId: file.projectId });

  const runAsync = args.wait !== true;
  if (!runAsync) {
    assertSyncIngestible(file);
  }

  await assertCorpusWriteQuotas({ projectId: file.projectId, addedBytes: 0 });
  const ask = await askEmbeddingWrite({
    projectId: file.projectId,
    principal: principalOfAuthority(args.authority),
    work: `The re-ingest of document ${args.id}`,
  });

  log(
    'reingestDocument: id=%s wait=%s strategy=%s',
    args.id,
    !runAsync,
    args.chunkStrategy ?? 'page'
  );

  const docId = doc.id as number;

  // Start from a clean slate so re-processing does not accumulate chunks.
  await db.DocumentChunk.destroy({ where: { documentId: docId } });
  await doc.update({
    status: 'pending',
    conversionAttemptId: null,
    pendingDocPath: null,
    error: null,
    totalPages: null,
    totalChunks: null,
    indexedChunks: null,
    // The text is about to be read again from the source, so a judgment about
    // the text it replaces no longer holds.
    tags: withoutContentBoundTags({
      keys: doc.file?.project?.contentBoundTagKeys ?? [],
      tags: doc.tags,
    }),
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
    endUser: args.endUser,
    authority: args.authority,
    ask,
  };

  return startDocumentIngestion({ pipelineArgs, runAsync });
};
