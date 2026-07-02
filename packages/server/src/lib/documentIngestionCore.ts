import createDebug from 'debug';

import { db } from '../db';
import { chunkPages, type ChunkStrategy, persistChunks } from './chunking';
import { emitEvent } from './eventBus';
import type { MappedIngestionRule } from './ingestionRules';
import { mapDocument } from './knowledge';

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

/** Shared JSON parse for `Document.metadata` — never throws. */
export const parseDocMetadata = (
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
  const strategy = args.chunkStrategy ?? rule?.chunkStrategy ?? 'page';
  return {
    strategy: strategy as ChunkStrategy,
    chunkSize: args.chunkSize ?? rule?.chunkSize ?? undefined,
    chunkOverlap: args.chunkOverlap ?? rule?.chunkOverlap ?? undefined,
  };
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
    fileId: string;
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
      metadata: JSON.stringify({
        source_file_id: args.fileId,
        failure_reason: 'FILE_PARSE_FAILED',
      }),
    });
    log('finalizeIngestedPages: no extractable text docId=%d', docId);
    return;
  }

  const chunks = chunkPages({
    pages: args.pages,
    ...resolveChunkConfig(args, args.rule),
  });

  await persistChunksWithProgress({
    doc,
    docId,
    fileId: args.fileId,
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
    metadata: JSON.stringify({
      source_file_id: args.fileId,
      total_pages: args.pages.length,
      total_chunks: chunks.length,
      chunk_count: chunks.length,
    }),
  });

  log('finalizeIngestedPages: ready docId=%d chunks=%d', docId, chunks.length);

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
