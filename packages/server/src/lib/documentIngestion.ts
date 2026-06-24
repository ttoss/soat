import fs from 'node:fs';

import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { getEmbedding } from './embedding';
import { emitEvent } from './eventBus';
import { mapDocument } from './knowledge';
import { extractPdfPages } from './pdf';

const log = createDebug('soat:documents');

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

const createDocumentChunk = async (args: {
  documentId: number;
  content: string;
  chunkIndex: number;
  pageNumber?: number;
}) => {
  log(
    'createDocumentChunk: documentId=%d chunkIndex=%d pageNumber=%s',
    args.documentId,
    args.chunkIndex,
    args.pageNumber ?? 'null'
  );

  let embedding: number[] | null = null;
  try {
    embedding = await getEmbedding({ text: args.content });
  } catch {
    // embedding is optional — continue without it
  }

  return db.DocumentChunk.create({
    documentId: args.documentId,
    content: args.content,
    chunkIndex: args.chunkIndex,
    pageNumber: args.pageNumber ?? null,
    embedding,
  });
};

const createChunksForDocument = async (args: {
  documentId: number;
  pages: { text: string; pageNumber: number }[];
  chunkStrategy: 'page' | 'whole';
}) => {
  if (args.chunkStrategy === 'whole') {
    const content = args.pages
      .map((p) => {
        return p.text;
      })
      .join('\n');
    await createDocumentChunk({
      documentId: args.documentId,
      content,
      chunkIndex: 0,
    });
    return;
  }
  for (let i = 0; i < args.pages.length; i++) {
    await createDocumentChunk({
      documentId: args.documentId,
      content: args.pages[i].text,
      chunkIndex: i,
      pageNumber: args.pages[i].pageNumber,
    });
  }
};

const loadPdfFile = async (fileId: string) => {
  const file = await db.File.findOne({
    where: { publicId: fileId },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!file) {
    throw new DomainError('FILE_NOT_FOUND', `File '${fileId}' not found.`);
  }

  if (file.contentType !== 'application/pdf') {
    throw new DomainError(
      'NOT_A_PDF',
      `File '${fileId}' is not a PDF (content type: ${file.contentType ?? 'unknown'}).`
    );
  }

  return file;
};

export const createDocumentsFromFile = async (args: {
  fileId: string;
  projectId: number;
  pathPrefix?: string;
  tags?: Record<string, string>;
  chunkStrategy?: 'page' | 'whole';
}) => {
  log(
    'createDocumentsFromFile: fileId=%s projectId=%d',
    args.fileId,
    args.projectId
  );

  const file = await loadPdfFile(args.fileId);
  const buffer = fs.readFileSync(file.storagePath);
  const rawPages = await extractPdfPages({ buffer });
  const pages = rawPages
    .map((text, i) => {
      return { text: text.trim(), pageNumber: i + 1 };
    })
    .filter((p) => {
      return p.text.length > 0;
    });

  if (pages.length === 0) {
    throw new DomainError('PDF_PARSE_FAILED', 'The PDF contains no text.');
  }

  const filename = file.filename ?? 'document.pdf';
  const docPath = args.pathPrefix
    ? `${args.pathPrefix.replace(/\/$/, '')}/${filename}`
    : `/${filename}`;

  const doc = await db.Document.create({
    fileId: file.id,
    title: filename,
    metadata: JSON.stringify({
      source_file_id: args.fileId,
      total_pages: rawPages.length,
    }),
    tags: args.tags ?? null,
  });

  await createChunksForDocument({
    documentId: doc.id as number,
    pages,
    chunkStrategy: args.chunkStrategy ?? 'page',
  });

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
        chunkCount: pages.length,
      },
      timestamp: new Date().toISOString(),
    });
  }

  return { ...mapped, chunkCount: pages.length };
};
