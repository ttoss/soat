import createDebug from 'debug';

import { db } from '../db';
import { chunkPages, type ChunkStrategy, persistChunks } from './chunking';
import { mapDocument } from './documentMapper';
import { emitResourceEvent } from './eventBus';
import type { MappedIngestionRule } from './ingestionRules';

const log = createDebug('soat:documents');

export type IngestedDoc = InstanceType<(typeof db)['Document']> & {
  file?: InstanceType<(typeof db)['File']> & {
    project?: InstanceType<(typeof db)['Project']>;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fileProjectInclude = (): any[] => {
  return [
    {
      model: db.File,
      as: 'file',
      include: [{ model: db.Project, as: 'project' }],
    },
  ];
};

export const fetchIngestedDocById = (
  id: number
): Promise<IngestedDoc | null> => {
  return db.Document.findOne({
    where: { id },
    include: fileProjectInclude(),
  }) as Promise<IngestedDoc | null>;
};

/**
 * Emits the terminal ingestion event for a document (#1041). Every path that
 * settles an ingestion — the pipeline tail here, the async-callback completion,
 * the pipeline's catch-all, and the stall sweeper — ends in one of these, so a
 * subscriber learns that a document became queryable (or gave up) without
 * polling `GET /documents/{id}/status` and edge-triggering on the change.
 *
 * The document is re-read with its file and project because a settle site may
 * only hold the bare row, and the envelope needs the owning project. A document
 * whose project can no longer be resolved (its file was deleted underneath the
 * ingestion) emits nothing: an event is best-effort and must never fail the
 * write that produced it.
 */
export const emitIngestionSettled = async (args: {
  docId: number;
  type: 'documents.ingested' | 'documents.ingest_failed';
  data?: Record<string, unknown>;
}): Promise<void> => {
  const fetched = await fetchIngestedDocById(args.docId);
  const project = fetched?.file?.project;
  if (!fetched || !project) {
    log('emitIngestionSettled: no project for docId=%d — dropping', args.docId);
    return;
  }

  emitResourceEvent({
    type: args.type,
    projectId: project.id,
    projectPublicId: project.publicId,
    resourceType: 'document',
    resourceId: fetched.publicId,
    data: { ...mapDocument(fetched), ...args.data },
  });
};

/**
 * The failure half of {@link emitIngestionSettled}, swallowing its own errors.
 * Its callers are failure handlers themselves — a rejected emit there would
 * replace the real ingestion error with a secondary one, or surface as an
 * unhandled rejection on the background path.
 */
export const emitIngestFailed = async (args: {
  docId: number;
  error: string;
}): Promise<void> => {
  try {
    await emitIngestionSettled({
      docId: args.docId,
      type: 'documents.ingest_failed',
      data: { error: args.error },
    });
  } catch (error) {
    log('emitIngestFailed: docId=%d error=%o', args.docId, error);
  }
};

export type ChunkConfigInput = {
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
};

// Per-request chunk config wins; otherwise fall back to the converter rule's
// defaults, then to the pipeline default.
export const resolveChunkConfig = (
  args: ChunkConfigInput,
  rule: MappedIngestionRule | null
): { strategy: ChunkStrategy; chunkSize?: number; chunkOverlap?: number } => {
  const strategy = args.chunkStrategy ?? rule?.chunk_strategy ?? 'page';
  return {
    strategy: strategy as ChunkStrategy,
    chunkSize: args.chunkSize ?? rule?.chunk_size ?? undefined,
    chunkOverlap: args.chunkOverlap ?? rule?.chunk_overlap ?? undefined,
  };
};

/**
 * Persist chunks while keeping the document's progress state current.
 * Records the totals up front (so the status endpoint has a denominator) and
 * periodically rewrites `indexedChunks`, which also bumps `updatedAt` to keep
 * a long-running ingestion from looking stalled (issue #4). These are typed
 * columns, not `metadata` — that bag is caller-owned and a `PATCH` replacing
 * it must never disturb ingestion progress (#845).
 */
const persistChunksWithProgress = async (args: {
  doc: InstanceType<(typeof db)['Document']>;
  docId: number;
  totalPages: number;
  chunks: { content: string; chunkIndex: number; pageNumber?: number }[];
}): Promise<void> => {
  const writeProgress = (indexed: number) => {
    return args.doc.update({
      totalPages: args.totalPages,
      totalChunks: args.chunks.length,
      indexedChunks: indexed,
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

/**
 * Finishes a document once its source pages are known — chunk, embed, mark
 * `ready` (or `failed` with `FILE_PARSE_FAILED` when there is no extractable
 * text), and emit the `documents.created` event. Shared by the synchronous
 * pipeline tail (`documentIngestion.ts`) and the async-callback completion
 * path (`ingestionCallback.ts`), which both arrive here once pages are
 * available — the only difference is where the pages came from.
 */
export const finalizeIngestedPages = async (
  args: ChunkConfigInput & {
    doc: InstanceType<(typeof db)['Document']>;
    docId: number;
    docPath: string;
    pages: { text: string; pageNumber?: number }[];
    rule: MappedIngestionRule | null;
  }
): Promise<void> => {
  const { doc, docId } = args;

  if (args.pages.length === 0) {
    await doc.update({
      status: 'failed',
      conversionAttemptId: null,
      pendingDocPath: null,
      failureReason: 'FILE_PARSE_FAILED',
    });
    log('finalizeIngestedPages: no extractable text docId=%d', docId);
    await emitIngestFailed({ docId, error: 'FILE_PARSE_FAILED' });
    return;
  }

  const chunkConfig = resolveChunkConfig(args, args.rule);
  const chunks = chunkPages({
    pages: args.pages,
    ...chunkConfig,
  });

  await persistChunksWithProgress({
    doc,
    docId,
    totalPages: args.pages.length,
    chunks,
  });

  const file = await db.File.findByPk(doc.fileId);
  if (file) {
    await file.update({ path: args.docPath });
  }

  await doc.update({
    status: 'ready',
    conversionAttemptId: null,
    pendingDocPath: null,
    failureReason: null,
    // Persist the effective chunk config so the document reads back the settings
    // it was ingested with (formation round-trip / drift convergence).
    chunkStrategy: chunkConfig.strategy,
    chunkSize: chunkConfig.chunkSize ?? null,
    chunkOverlap: chunkConfig.chunkOverlap ?? null,
    totalPages: args.pages.length,
    totalChunks: chunks.length,
  });

  log('finalizeIngestedPages: ready docId=%d chunks=%d', docId, chunks.length);

  const fetched = await fetchIngestedDocById(docId);
  const project = fetched?.file?.project;
  if (fetched && project) {
    emitResourceEvent({
      type: 'documents.created',
      projectId: project.id,
      projectPublicId: project.publicId,
      resourceType: 'document',
      resourceId: fetched.publicId,
      data: {
        ...mapDocument(fetched),
        // snake_case, like every other key on the wire: a webhook payload uses
        // the same names the REST response does (`case-convention.md`). This
        // one shipped as `chunkCount` and was the only camelCase key in the
        // envelope.
        chunk_count: chunks.length,
      },
    });
  }

  // The document is now queryable — the event a fronting layer waits on.
  await emitIngestionSettled({
    docId,
    type: 'documents.ingested',
    data: { chunk_count: chunks.length },
  });
};
