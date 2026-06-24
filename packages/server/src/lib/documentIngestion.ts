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

/**
 * Extract the source text from a file, dispatched on its content type. PDFs are
 * parsed page-by-page; text/markdown files become a single page. Blank pages are
 * dropped so chunk counts reflect real content.
 */
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

export const createDocumentFromFile = async (args: {
  fileId: string;
  projectId: number;
  pathPrefix?: string;
  tags?: Record<string, string>;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
}) => {
  log(
    'createDocumentFromFile: fileId=%s projectId=%d strategy=%s',
    args.fileId,
    args.projectId,
    args.chunkStrategy ?? 'page'
  );

  const file = await loadIngestibleFile(args.fileId);
  const pages = await extractSourcePages(file);

  if (pages.length === 0) {
    throw new DomainError(
      'FILE_PARSE_FAILED',
      `File '${args.fileId}' contains no extractable text.`
    );
  }

  const chunks = chunkPages({
    pages,
    strategy: args.chunkStrategy ?? 'page',
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
  });

  const filename = file.filename ?? 'document';
  const docPath = args.pathPrefix
    ? `${args.pathPrefix.replace(/\/$/, '')}/${filename}`
    : `/${filename}`;

  const doc = await db.Document.create({
    fileId: file.id,
    title: filename,
    metadata: JSON.stringify({
      source_file_id: args.fileId,
      total_pages: pages.length,
    }),
    tags: args.tags ?? null,
  });

  await persistChunks({ documentId: doc.id as number, chunks });

  await file.update({ path: docPath });

  const created = await fetchIngestedDocById(doc.id as number);
  const mapped = mapDocument(created!);

  const project = created?.file?.project;
  if (project) {
    emitEvent({
      type: 'documents.created',
      projectId: project.id,
      projectPublicId: project.publicId,
      resourceType: 'document',
      resourceId: created!.publicId,
      data: {
        ...(mapped as unknown as Record<string, unknown>),
        chunkCount: chunks.length,
      },
      timestamp: new Date().toISOString(),
    });
  }

  return { ...mapped, chunkCount: chunks.length };
};
