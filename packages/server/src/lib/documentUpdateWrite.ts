import type { ChunkStrategy } from './chunking';
import {
  changesReadableText,
  restoredTags,
  withoutContentBoundTags,
} from './contentBoundTags';
import type { Transaction } from './dbTransaction';
import {
  commitDocumentChunkChanges,
  type PreparedChunkChange,
} from './documentContent';
import type { LoadedDoc } from './documentLoaders';
import { normalizeStatedPath } from './documentWriteGuard';
import { rethrowAsPathConflict } from './filePathConflict';

// Build the set of Document column updates from the (partial) update args.
// Only fields that are explicitly provided are written.
const buildDocumentColumnUpdates = (args: {
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  tags?: Record<string, string> | null;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
}): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  if (args.title !== undefined) updates.title = args.title;
  if (args.metadata !== undefined) updates.metadata = args.metadata;
  if (args.tags !== undefined) updates.tags = args.tags;
  if (args.chunkStrategy !== undefined)
    updates.chunkStrategy = args.chunkStrategy;
  if (args.chunkSize !== undefined) updates.chunkSize = args.chunkSize;
  if (args.chunkOverlap !== undefined) updates.chunkOverlap = args.chunkOverlap;
  return updates;
};

/** Every write of an update, run in its version's transaction. */
export const writeDocumentUpdate = async (a: {
  doc: LoadedDoc;
  args: Parameters<typeof buildDocumentColumnUpdates>[0] & {
    path?: string | null;
    revivesWithdrawn?: boolean;
  };
  chunkChange: PreparedChunkChange | null;
  transaction: Transaction;
}) => {
  const { doc, transaction } = a;
  const updates = buildDocumentColumnUpdates(a.args);
  // The status and the version that revives it commit together.
  if (a.args.revivesWithdrawn) updates.status = 'ready';
  if (Object.keys(updates).length > 0) {
    await doc.update(updates, { transaction });
  }
  if (a.args.path !== undefined && doc.file) {
    await doc.file
      .update({ path: normalizeStatedPath(a.args.path) }, { transaction })
      .catch(rethrowAsPathConflict);
  }
  if (a.chunkChange) {
    await commitDocumentChunkChanges({
      doc,
      change: a.chunkChange,
      transaction,
    });
  }
};

/**
 * The bag an update writes (`lib/contentBoundTags.ts`):
 * - the one the caller sets, as sent: its keys are the ones that write stated;
 * - else a restore's archived bag, which never brings back a content-bound
 *   value (`restoredTags`);
 * - else, when the update changes text an agent can read, the stored bag minus
 *   the project's content-bound keys: a verdict nobody restated in this write;
 * - else `undefined`, leaving the stored bag.
 */
export const tagsAfterUpdate = (args: {
  doc: LoadedDoc;
  update: {
    content?: string;
    title?: string | null;
    path?: string | null;
    metadata?: Record<string, unknown> | null;
    tags?: Record<string, string> | null;
    /** A restore's archived bag: written, but not stated by the caller. */
    archivedTags?: Record<string, string> | null;
    revivesWithdrawn?: boolean;
  };
  currentContent: string | null;
}): Record<string, string> | null | undefined => {
  const { doc, update } = args;
  if (update.tags !== undefined) return update.tags;
  const changed =
    update.revivesWithdrawn === true ||
    changesReadableText([
      [update.content, args.currentContent],
      [update.title, doc.title],
      [
        update.path === undefined
          ? undefined
          : normalizeStatedPath(update.path),
        doc.file?.path,
      ],
      [update.metadata, doc.metadata],
    ]);
  const keys = doc.file?.project?.contentBoundTagKeys ?? [];
  if (update.archivedTags !== undefined) {
    return restoredTags({
      keys,
      archived: update.archivedTags,
      current: doc.tags,
      textChanged: changed,
    });
  }
  if (!changed) return undefined;
  return withoutContentBoundTags({ keys, tags: doc.tags });
};
