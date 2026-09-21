import { db } from '../db';
import { fetchDocumentWithContext } from './documentLoaders';
import { mapDocument } from './documentMapper';
import { recoverStaleDocument } from './ingestionCallback';

/**
 * The lightweight ingestion read a poller uses, kept apart from the document
 * reads that assemble content: the whole point of it is that it never touches
 * the multi-megabyte chunk text.
 */

/**
 * Compute an ingestion progress percentage (0–100) from the live chunk count
 * and the planned total. `null` when progress is not meaningful (failed, or
 * processing before the total is known). Capped at 99 while still `processing`
 * so it only reads 100 once the document is `ready`.
 */
const computeIngestionProgress = (args: {
  status: string;
  chunkCount: number;
  totalChunks?: number;
}): number | null => {
  if (args.status === 'ready') return 100;
  if (args.status === 'pending') return 0;
  if (args.status !== 'processing') return null; // failed / unknown
  if (typeof args.totalChunks !== 'number' || args.totalChunks <= 0)
    return null;
  const pct = Math.floor((args.chunkCount / args.totalChunks) * 100);
  return Math.max(0, Math.min(99, pct));
};

/**
 * Lightweight ingestion status for polling (#5, #6) — the lifecycle fields
 * only, never the multi-megabyte chunk content `getDocument` assembles.
 * Self-recovers a stalled document to `failed` so a poller reaches a terminal
 * state (#4).
 *
 * - `chunk_count` — chunks currently indexed; grows during `processing`.
 * - `total_chunks` — planned total, `null` until chunking starts.
 * - `total_pages` — source pages, `null` until extraction has run (not zero).
 * - `progress` — percentage, capped at 99 while `processing`, `null` when
 *   `failed` or not yet computable.
 */
export const getDocumentStatus = async (args: { id: string }) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) return null;

  await recoverStaleDocument(doc);

  const mapped = mapDocument(doc);

  // Always report the live count so the value is meaningful while processing,
  // not just after the total is persisted on completion.
  const chunkCount = await db.DocumentChunk.count({
    where: { documentId: doc.id },
  });

  const totalChunks = doc.totalChunks ?? undefined;

  return {
    id: mapped.id,
    status: doc.status,
    chunk_count: chunkCount,
    total_chunks: totalChunks ?? null,
    total_pages: doc.totalPages ?? null,
    progress: computeIngestionProgress({
      status: doc.status,
      chunkCount,
      totalChunks,
    }),
    error:
      doc.status === 'failed' ? (doc.failureReason ?? undefined) : undefined,
    // For the route's permission check, not the public response shape. Named
    // snake_case like every lib return — a camelCase twin here silently
    // resolves to `undefined`.
    project_id: mapped.project_id,
    path: mapped.path,
    tags: mapped.tags,
  };
};
