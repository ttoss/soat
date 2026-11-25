/**
 * Pages of the files a citing turn was sent, labelled for citation. A turn
 * that cites reads an attached PDF or text file as its extracted text, one
 * labelled passage per page; a page with no text (a scan) keeps the file in
 * the message, unlabelled, so the model still reads it.
 */
import createDebug from 'debug';

import { db } from '../db';
import type { CitationSource } from './citationVerification';
import { readFileBuffer } from './fileStorage';
import { fileIdOfReference } from './modelInputBoundary';
import { readPdfPages } from './pdf';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:citations');

const PAGED_TYPE = 'application/pdf';
const CITABLE_TYPES = new Set([PAGED_TYPE, 'text/plain', 'text/markdown']);

/** Which file and page a turn's attached label names: pointers only. */
export type AttachedSource = {
  ref: string;
  file_id: string;
  page: number | null;
};

type FilePage = { page: number | null; text: string };

const attachedRef = (index: number): string => {
  return `a${index + 1}`;
};

/** Every page of a stored file, empty ones included; null when unreadable. */
const readFilePages = async (args: {
  fileId: string;
  projectId: number;
}): Promise<{ filename: string; pages: FilePage[] } | null> => {
  const file = await db.File.findOne({
    where: { publicId: args.fileId, projectId: args.projectId },
  });
  const buffer = file
    ? await readFileBuffer({
        storageType: file.storageType,
        storagePath: file.storagePath,
      })
    : null;
  if (!file || !buffer) return null;
  const filename = file.filename ?? file.publicId;
  if (file.contentType !== PAGED_TYPE) {
    return {
      filename,
      pages: [{ page: null, text: buffer.toString('utf-8') }],
    };
  }
  const texts = await readPdfPages({ buffer });
  if (!texts) return null;
  return {
    filename,
    pages: texts.map((text, index) => {
      return { page: index + 1, text };
    }),
  };
};

/** The file a message part attaches, when its type can be cited. */
const citableFileId = (part: unknown): string | null => {
  if (!isPlainObject(part) || part.type !== 'file') return null;
  if (typeof part.data !== 'string' || typeof part.mediaType !== 'string') {
    return null;
  }
  return CITABLE_TYPES.has(part.mediaType)
    ? fileIdOfReference(part.data)
    : null;
};

const pageHeader = (args: {
  filename: string;
  page: number | null;
  ref: string;
}): string => {
  const page = args.page === null ? '' : ` (page ${args.page})`;
  return `[File: ${args.filename}${page} ${args.ref}]`;
};

/**
 * The message parts that replace one attached file: its labelled text, and
 * the file itself when a page has no text to label.
 */
const labelFilePart = async (args: {
  part: unknown;
  fileId: string;
  projectId: number;
  sources: AttachedSource[];
}): Promise<unknown[]> => {
  const read = await readFilePages(args);
  if (!read) return [args.part];
  const passages = read.pages.flatMap(({ page, text }) => {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const ref = attachedRef(args.sources.length);
    args.sources.push({ ref, file_id: args.fileId, page });
    return [
      `${pageHeader({ filename: read.filename, page, ref })}\n${trimmed}`,
    ];
  });
  const labelled = passages.length
    ? [
        {
          type: 'text',
          text: `<attached-file name="${read.filename}">\n${passages.join('\n\n')}\n</attached-file>`,
        },
      ]
    : [];
  const unlabelled = passages.length < read.pages.length ? [args.part] : [];
  return [...labelled, ...unlabelled];
};

export const labelAttachedFiles = async (args: {
  messages: Array<{ role: string; content: unknown }>;
  projectId: number;
}): Promise<{
  messages: Array<{ role: string; content: unknown }>;
  sources: AttachedSource[];
}> => {
  const sources: AttachedSource[] = [];
  const messages: Array<{ role: string; content: unknown }> = [];
  for (const message of args.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      messages.push(message);
      continue;
    }
    const content: unknown[] = [];
    for (const part of message.content) {
      const fileId = citableFileId(part);
      content.push(
        ...(fileId
          ? await labelFilePart({
              part,
              fileId,
              projectId: args.projectId,
              sources,
            })
          : [part])
      );
    }
    messages.push({ ...message, content });
  }
  log('labelAttachedFiles: labels=%d', sources.length);
  return { messages, sources };
};

/** Each attached label's page text, read again; null when it no longer reads. */
export const loadAttachedSources = async (args: {
  sources: AttachedSource[];
  projectId: number;
}): Promise<Record<string, CitationSource | null>> => {
  const files = new Map<string, Awaited<ReturnType<typeof readFilePages>>>();
  for (const { file_id: fileId } of args.sources) {
    if (!files.has(fileId)) {
      files.set(
        fileId,
        await readFilePages({ fileId, projectId: args.projectId })
      );
    }
  }
  return Object.fromEntries(
    args.sources.map(({ ref, file_id: fileId, page }) => {
      const pages = files.get(fileId)?.pages ?? [];
      const found = pages.find((candidate) => {
        return candidate.page === page;
      });
      const source: CitationSource | null = found
        ? {
            origin: 'attached_file',
            documentId: null,
            documentVersion: null,
            chunkId: null,
            fileId,
            page,
            text: found.text.trim(),
          }
        : null;
      return [ref, source];
    })
  );
};
