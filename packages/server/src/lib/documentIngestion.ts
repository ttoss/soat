import fs from 'node:fs';

import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  chunkPages,
  type ChunkStrategy,
  persistChunks,
  type SourcePage,
} from './chunking';
import { emitEvent } from './eventBus';
import { mapDocument } from './knowledge';
import { extractPdfPages } from './pdf';

const log = createDebug('soat:documents');

const SUPPORTED_CONTENT_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
];

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

const loadIngestibleFile = async (fileId: string) => {
  const file = await db.File.findOne({
    where: { publicId: fileId },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!file) {
    throw new DomainError('FILE_NOT_FOUND', `File '${fileId}' not found.`);
  }

  if (!SUPPORTED_CONTENT_TYPES.includes(file.contentType ?? '')) {
    throw new DomainError(
      'UNSUPPORTED_FILE_TYPE',
      `File '${fileId}' has unsupported content type '${file.contentType ?? 'unknown'}'. Supported: ${SUPPORTED_CONTENT_TYPES.join(', ')}.`
    );
  }

  return file;
};

const extractSourcePages = async (
  file: InstanceType<(typeof db)['File']>
): Promise<SourcePage[]> => {
  const buffer = fs.readFileSync(file.storagePath);

  if (file.contentType === 'application/pdf') {
    const rawPages = await extractPdfPages({ buffer });
    return rawPages
      .map((text, i) => {
        return { text: text.trim(), pageNumber: i + 1 };
      })
      .filter((page) => {
        return page.text.length > 0;
      });
  }

  // text/plain, text/markdown
  const text = buffer.toString('utf-8').trim();
  return text.length > 0 ? [{ text, pageNumber: 1 }] : [];
};

type IngestionPipelineArgs = {
  doc: InstanceType<(typeof db)['Document']>;
  fileId: string;
  docPath: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
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

  const pages = await extractSourcePages(file);

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

  const chunks = chunkPages({
    pages,
    strategy: args.chunkStrategy ?? 'page',
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
  });

  await persistChunks({ documentId: docId, chunks });
  await file.update({ path: args.docPath });
  await doc.update({
    status: 'ready',
    metadata: JSON.stringify({
      source_file_id: args.fileId,
      total_pages: pages.length,
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
          failure_reason: String(error),
        }),
      });
    } catch {
      // ignore secondary failure
    }
  }
};

/**
 * Validate the file and create a Document record. When `wait` is true the
 * pipeline runs synchronously and the document is returned with `status=ready`
 * (HTTP 201). When `wait` is false (default) processing is deferred to the
 * next event loop tick and the document is returned with `status=pending`
 * (HTTP 202).
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
}) => {
  log(
    'enqueueDocumentIngestion: fileId=%s projectId=%d strategy=%s wait=%s',
    args.fileId,
    args.projectId,
    args.chunkStrategy ?? 'page',
    args.wait ?? false
  );

  const file = await loadIngestibleFile(args.fileId);

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

  if (args.wait) {
    await processDocumentIngestion(pipelineArgs);
  } else {
    setImmediate(() => {
      void processDocumentIngestion(pipelineArgs);
    });
  }

  const fetched = await fetchIngestedDocById(docId);
  return mapDocument(fetched!);
};
