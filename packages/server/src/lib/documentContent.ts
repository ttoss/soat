import createDebug from 'debug';

import { db } from '../db';
import { chunkPages, type ChunkStrategy, persistChunks } from './chunking';
import { resolveProjectPublicId } from './eventBus';
import {
  getActiveStorageProvider,
  getStorageProvider,
  streamToBuffer,
} from './fileStorage';
import { categoryFromPath, persistFileBytes } from './fileStorageLayout';

const log = createDebug('soat:documents');

/** A document's stored object always holds UTF-8 text, whatever it is named. */
export const DOCUMENT_TEXT_EXTENSION = '.txt';

/**
 * Whether a file's stored bytes are the document's own text, rather than a
 * source binary it was ingested from. Only the former is ours to overwrite: an
 * ingested PDF is the caller's upload, still served by the files API.
 */
const holdsDocumentText = (file: NonNullable<DocWithFile['file']>): boolean => {
  return file.contentType === 'text/plain';
};

export type DocWithFile = InstanceType<(typeof db)['Document']> & {
  file?: InstanceType<(typeof db)['File']>;
};

/**
 * Create the backing File row for a document and write its text. Lives beside
 * the rewrite below so both writers of a document's object agree on where it is.
 */
export const createDocumentTextFile = async (args: {
  projectId: number;
  content: string;
  normalizedPath: string | null;
  filename?: string;
}): Promise<InstanceType<(typeof db)['File']>> => {
  const provider = getActiveStorageProvider();
  const file = await db.File.create({
    projectId: args.projectId,
    path: args.normalizedPath,
    filename: args.filename ?? 'document.txt',
    contentType: 'text/plain',
    size: Buffer.byteLength(args.content, 'utf-8'),
    storageType: provider.storageType,
    storagePath: '',
  });

  await persistFileBytes({
    provider,
    file,
    projectPublicId: await resolveProjectPublicId({
      projectId: args.projectId,
    }),
    category: categoryFromPath(args.normalizedPath),
    buffer: Buffer.from(args.content, 'utf-8'),
    contentType: 'text/plain',
    extension: DOCUMENT_TEXT_EXTENSION,
  });
  return file;
};

/**
 * Read a document's original source text from file storage. Unlike the
 * chunk-reconstructed content `getDocument` returns, this is the exact text the
 * document was created with — the `size` strategy joins overlapping windows with
 * newlines, so reconstructing from chunks would not match the original. Formation
 * `read` uses this so a document's `content` round-trips regardless of strategy.
 */
export const readFileContent = async (
  file: DocWithFile['file']
): Promise<string | null> => {
  if (!file?.storagePath) return null;
  const provider = getStorageProvider({ storageType: file.storageType });
  const object = await provider.read({ storagePath: file.storagePath });
  if (!object) return null;
  return (await streamToBuffer(object.stream)).toString('utf-8');
};

/**
 * Chunk plain document text and persist the chunks. Treats the content as a
 * single source "page" and applies the requested strategy (default `whole`,
 * i.e. one chunk — the historical behavior). Lets any document creation chunk,
 * not just file ingestion.
 */
export const chunkDocumentText = async (args: {
  documentId: number;
  projectId: number;
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
  await persistChunks({
    documentId: args.documentId,
    projectId: args.projectId,
    chunks,
  });
};

/**
 * Overwrite the stored source text (when new content is supplied) and re-chunk
 * the document with the given strategy.
 */
const rechunkDocument = async (args: {
  doc: DocWithFile;
  content: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
  rewriteStorage: boolean;
}) => {
  const file = args.doc.file;
  // A document's project is its file's, and a re-chunk meters the embeddings it
  // makes — so without the association loaded there is nothing to charge and
  // nothing to rewrite. Returning before the destroy keeps the existing chunks.
  if (!file) return;

  if (args.rewriteStorage && file.storagePath && holdsDocumentText(file)) {
    await persistFileBytes({
      provider: getStorageProvider({ storageType: file.storageType }),
      file,
      projectPublicId: await resolveProjectPublicId({
        projectId: file.projectId,
      }),
      category: categoryFromPath(file.path),
      buffer: Buffer.from(args.content, 'utf-8'),
      contentType: 'text/plain',
      extension: DOCUMENT_TEXT_EXTENSION,
    });
  }

  await db.DocumentChunk.destroy({ where: { documentId: args.doc.id } });

  await chunkDocumentText({
    documentId: args.doc.id as number,
    projectId: file.projectId,
    content: args.content,
    chunkStrategy: args.chunkStrategy,
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
  });
};

// Effective chunk config for a re-chunk: an explicitly-supplied value wins;
// otherwise the document keeps what it was last chunked with (null → default).
const resolveEffectiveChunkConfig = (args: {
  doc: DocWithFile;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
}) => {
  return {
    chunkStrategy: args.chunkStrategy ?? args.doc.chunkStrategy ?? undefined,
    chunkSize: args.chunkSize ?? args.doc.chunkSize ?? undefined,
    chunkOverlap: args.chunkOverlap ?? args.doc.chunkOverlap ?? undefined,
  };
};

/**
 * Apply chunk-related changes on update: re-chunk when any chunk field changes,
 * or rewrite content + re-chunk when new content is supplied. A strategy-only
 * change re-chunks the existing stored source text. No-op when neither the
 * content nor any chunk field is provided.
 */
export const applyDocumentChunkChanges = async (args: {
  doc: DocWithFile;
  content?: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
}) => {
  const chunkConfigChanged =
    args.chunkStrategy !== undefined ||
    args.chunkSize !== undefined ||
    args.chunkOverlap !== undefined;
  if (args.content === undefined && !chunkConfigChanged) return;

  const content = args.content ?? (await readFileContent(args.doc.file));
  if (content === null) return;

  log('applyDocumentChunkChanges: re-chunking docId=%s', args.doc.id);
  await rechunkDocument({
    doc: args.doc,
    content,
    ...resolveEffectiveChunkConfig(args),
    rewriteStorage: args.content !== undefined,
  });
};
