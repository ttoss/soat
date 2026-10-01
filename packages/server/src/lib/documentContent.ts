import createDebug from 'debug';

import { db } from '../db';
import {
  chunkPages,
  type ChunkStrategy,
  embedChunks,
  type EmbeddedChunk,
  joinChunks,
  persistChunks,
} from './chunking';
import type { Transaction } from './dbTransaction';
import { resolveProjectPublicId } from './eventBus';
import { rethrowAsPathConflict } from './filePathConflict';
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
  let file: InstanceType<(typeof db)['File']>;
  try {
    file = await db.File.create({
      projectId: args.projectId,
      path: args.normalizedPath,
      filename: args.filename ?? 'document.txt',
      contentType: 'text/plain',
      size: Buffer.byteLength(args.content, 'utf-8'),
      storageType: provider.storageType,
      storagePath: '',
    });
  } catch (error) {
    throw rethrowAsPathConflict(error);
  }

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

/** Read a file's stored bytes as UTF-8 text. */
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
 * A document's text: the stored text when the file holds it, else the text its
 * chunks were cut from (an ingested binary keeps only the extracted pages).
 */
export const readDocumentText = async (
  doc: DocWithFile
): Promise<string | null> => {
  if (doc.file && holdsDocumentText(doc.file)) {
    const stored = await readFileContent(doc.file);
    if (stored !== null) return stored;
  }

  const chunks = await db.DocumentChunk.findAll({
    where: { documentId: doc.id },
    order: [['chunkIndex', 'ASC']],
  });
  if (chunks.length === 0) return readFileContent(doc.file);

  return joinChunks({
    chunks: chunks.map((c) => {
      return c.content;
    }),
    strategy: doc.chunkStrategy,
    chunkSize: doc.chunkSize,
    chunkOverlap: doc.chunkOverlap,
  });
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
  embed?: boolean;
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
    embed: args.embed,
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

/** What an update re-chunks to, computed before its transaction opens. */
export type PreparedChunkChange = {
  content: string;
  rewriteStorage: boolean;
  /** Where the text is stored, read from the path before the update moves it. */
  category: string;
  rows: EmbeddedChunk[];
};

/**
 * The half of an update's chunk change that calls out: reads the stored text
 * when only the chunk config changes, splits it and embeds it. Writes nothing,
 * so a writer that loses the version claim has nothing to undo. `null` when
 * neither the content nor any chunk field is supplied.
 */
export const prepareDocumentChunkChanges = async (args: {
  doc: DocWithFile;
  content?: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
}): Promise<PreparedChunkChange | null> => {
  const chunkConfigChanged =
    args.chunkStrategy !== undefined ||
    args.chunkSize !== undefined ||
    args.chunkOverlap !== undefined;
  if (args.content === undefined && !chunkConfigChanged) return null;

  // A document's project is its file's, and a re-chunk meters the embeddings
  // it makes, so without the association loaded there is nothing to charge.
  const file = args.doc.file;
  if (!file) return null;

  const content = args.content ?? (await readFileContent(file));
  if (content === null) return null;

  log('prepareDocumentChunkChanges: re-chunking docId=%s', args.doc.id);
  const config = resolveEffectiveChunkConfig(args);
  const chunks = chunkPages({
    pages: [{ text: content }],
    strategy: config.chunkStrategy ?? 'whole',
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
  });

  return {
    content,
    rewriteStorage: args.content !== undefined,
    category: categoryFromPath(file.path),
    rows: await embedChunks({
      projectId: file.projectId,
      documentId: args.doc.id as number,
      chunks,
    }),
  };
};

/**
 * The half that writes, inside the update's transaction: swaps the chunks and,
 * last, rewrites the stored text — the one write the transaction cannot roll
 * back.
 */
export const commitDocumentChunkChanges = async (args: {
  doc: DocWithFile;
  change: PreparedChunkChange;
  transaction: Transaction;
}): Promise<void> => {
  const { doc, change, transaction } = args;
  const documentId = doc.id as number;

  await db.DocumentChunk.destroy({ where: { documentId }, transaction });
  for (const row of change.rows) {
    await db.DocumentChunk.create(
      {
        documentId,
        content: row.content,
        chunkIndex: row.chunkIndex,
        pageNumber: row.pageNumber ?? null,
        embedding: row.embedding,
      },
      { transaction }
    );
  }

  const file = doc.file;
  if (change.rewriteStorage && file?.storagePath && holdsDocumentText(file)) {
    await persistFileBytes({
      provider: getStorageProvider({ storageType: file.storageType }),
      file,
      projectPublicId: await resolveProjectPublicId({
        projectId: file.projectId,
      }),
      category: change.category,
      buffer: Buffer.from(change.content, 'utf-8'),
      contentType: 'text/plain',
      extension: DOCUMENT_TEXT_EXTENSION,
      transaction,
    });
  }
};
