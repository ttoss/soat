import createDebug from 'debug';

import { db } from '../db';
import { getEmbedding } from './embedding';

const log = createDebug('soat:chunking');

/**
 * How a document's source text is split into embeddable chunks.
 *
 * - `page`  — one chunk per source page (PDF). Non-paged sources collapse to a
 *   single chunk. `pageNumber` is set on each chunk.
 * - `whole` — a single chunk containing all source text joined by newlines.
 * - `size`  — fixed-size character windows with overlap (size/overlap
 *   configurable). Page attribution is dropped.
 */
export type ChunkStrategy = 'page' | 'whole' | 'size';

export type SourcePage = { text: string; pageNumber?: number };

export type PreparedChunk = {
  content: string;
  chunkIndex: number;
  pageNumber?: number;
};

export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 200;

const chunkBySize = (args: {
  text: string;
  chunkSize: number;
  chunkOverlap: number;
}): string[] => {
  const size = Math.max(1, Math.floor(args.chunkSize));
  const overlap = Math.max(
    0,
    Math.min(Math.floor(args.chunkOverlap), size - 1)
  );
  const step = size - overlap;

  const chunks: string[] = [];
  for (let start = 0; start < args.text.length; start += step) {
    chunks.push(args.text.slice(start, start + size));
  }
  return chunks.length > 0 ? chunks : [''];
};

/**
 * Pure function: turn source pages into the chunk records to persist. Shared by
 * plain-text document creation and file ingestion so chunking is a Document-level
 * capability, not coupled to any single source format.
 */
export const chunkPages = (args: {
  pages: SourcePage[];
  strategy: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
}): PreparedChunk[] => {
  log('chunkPages: strategy=%s pages=%d', args.strategy, args.pages.length);

  if (args.strategy === 'whole') {
    const content = args.pages
      .map((p) => {
        return p.text;
      })
      .join('\n');
    return [{ content, chunkIndex: 0 }];
  }

  if (args.strategy === 'size') {
    const combined = args.pages
      .map((p) => {
        return p.text;
      })
      .join('\n');
    const parts = chunkBySize({
      text: combined,
      chunkSize: args.chunkSize ?? DEFAULT_CHUNK_SIZE,
      chunkOverlap: args.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
    });
    return parts.map((content, i) => {
      return { content, chunkIndex: i };
    });
  }

  // strategy === 'page'
  return args.pages.map((page, i) => {
    return { content: page.text, chunkIndex: i, pageNumber: page.pageNumber };
  });
};

export const DEFAULT_EMBEDDING_CONCURRENCY = 5;

const runBounded = async (
  count: number,
  concurrency: number,
  fn: (index: number) => Promise<void>
): Promise<void> => {
  let cursor = 0;
  const worker = async () => {
    while (cursor < count) {
      const i = cursor++;
      await fn(i);
    }
  };
  const slots = Math.min(concurrency, count);
  if (slots === 0) return;
  await Promise.all(Array.from({ length: slots }, worker));
};

/**
 * Persist prepared chunks as DocumentChunk rows. Embeddings are computed
 * with bounded concurrency (default: 5) so very large documents do not open
 * an unbounded number of simultaneous network requests. An embedding failure
 * is non-fatal — the chunk is stored without a vector.
 */
export const persistChunks = async (args: {
  documentId: number;
  chunks: PreparedChunk[];
  concurrency?: number;
}): Promise<void> => {
  const concurrency = args.concurrency ?? DEFAULT_EMBEDDING_CONCURRENCY;
  log(
    'persistChunks: documentId=%d count=%d concurrency=%d',
    args.documentId,
    args.chunks.length,
    concurrency
  );

  const embeddings: (number[] | null)[] = new Array(args.chunks.length).fill(
    null
  );

  await runBounded(args.chunks.length, concurrency, async (i) => {
    try {
      embeddings[i] = await getEmbedding({ text: args.chunks[i].content });
    } catch {
      // embedding is optional — continue without it
    }
  });

  for (let i = 0; i < args.chunks.length; i++) {
    const chunk = args.chunks[i];
    await db.DocumentChunk.create({
      documentId: args.documentId,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      pageNumber: chunk.pageNumber ?? null,
      embedding: embeddings[i],
    });
  }
};
