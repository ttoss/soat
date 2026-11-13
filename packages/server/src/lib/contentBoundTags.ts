import createDebug from 'debug';
import { db } from 'src/db';
import {
  emitDocumentLifecycleEvent,
  fetchDocumentByIdWithContext,
} from 'src/lib/documentLoaders';
import { mapDocument } from 'src/lib/documentMapper';
import { stableDigest } from 'src/lib/stableDigest';
import { isSystemTagKey, TAG_BAG_LIMITS } from 'src/lib/tags';

const log = createDebug('soat:contentBoundTags');

/**
 * Content-bound tag keys: tag keys a project declares to state a judgment
 * about what an agent can read (a screening verdict). The judgment must not
 * outlive the text it judged, so every write that changes an agent-readable
 * field other than tags removes them, unless that same write sets them. The
 * rule lives here once; the document and memory writes only report that their
 * readable text changed.
 */

/** Why a project's key list is refused, or `null` when it is valid. */
export const validateContentBoundTagKeys = (value: unknown): string | null => {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.some((key) => {
      return (
        typeof key !== 'string' ||
        key.length === 0 ||
        key.length > TAG_BAG_LIMITS.keyLength
      );
    })
  ) {
    return `content_bound_tag_keys must be an array of tag keys, each 1 to ${TAG_BAG_LIMITS.keyLength} characters, or null.`;
  }
  if (value.length > TAG_BAG_LIMITS.keys) {
    return `content_bound_tag_keys holds at most ${TAG_BAG_LIMITS.keys} keys.`;
  }
  const reserved = value.find(isSystemTagKey);
  if (reserved) {
    return `content_bound_tag_keys cannot name '${reserved}': system tags are written by the platform.`;
  }
  return null;
};

/**
 * Whether a write changes an agent-readable field it names. Each pair is the
 * value the write sends (`undefined` when it leaves the field) and the value
 * stored now; re-sending what is stored changes nothing.
 */
export const changesReadableText = (
  fields: Array<[next: unknown, current: unknown]>
): boolean => {
  return fields.some(([next, current]) => {
    return (
      next !== undefined && stableDigest(next) !== stableDigest(current ?? null)
    );
  });
};

/** The keys a project declares; `[]` when it names none. */
export const contentBoundTagKeysOf = async (args: {
  projectId: number;
}): Promise<string[]> => {
  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['contentBoundTagKeys'],
  });
  return project?.contentBoundTagKeys ?? [];
};

/** The keys of the project a memory store belongs to. */
export const contentBoundTagKeysOfStore = async (args: {
  memoryStoreId: number;
}): Promise<string[]> => {
  const store = await db.MemoryStore.findByPk(args.memoryStoreId, {
    attributes: ['projectId'],
  });
  if (!store) return [];
  return contentBoundTagKeysOf({ projectId: store.projectId });
};

/**
 * The tags a write leaves when it changed what an agent can read without
 * setting the bag itself: `tags` minus the content-bound `keys`. A write that
 * sets the bag needs no call here, since the keys it carries are the ones that
 * write stated.
 */
export const withoutContentBoundTags = (args: {
  keys: readonly string[];
  tags: Record<string, string> | null;
}): Record<string, string> | null => {
  const { tags } = args;
  if (!tags) return tags;
  const removed = args.keys.filter((key) => {
    return key in tags;
  });
  if (removed.length === 0) return tags;
  log('withoutContentBoundTags: removed=%o', removed);
  return Object.fromEntries(
    Object.entries(tags).filter(([key]) => {
      return !removed.includes(key);
    })
  );
};

/**
 * A document's `path` is its backing file's, so moving or renaming the file
 * changes text an agent reads the document by, and removes the document's
 * content-bound keys as a `path` update does.
 */
export const releaseContentBoundTagsOfMovedFile = async (args: {
  fileId: number;
}): Promise<void> => {
  const row = await db.Document.findOne({
    where: { fileId: args.fileId },
    attributes: ['id'],
  });
  if (!row) return;
  const doc = await fetchDocumentByIdWithContext(row.id as number);
  if (!doc) return;
  const tags = withoutContentBoundTags({
    keys: doc.file?.project?.contentBoundTagKeys ?? [],
    tags: doc.tags,
  });
  if (tags === doc.tags) return;
  await doc.update({ tags });
  emitDocumentLifecycleEvent({
    type: 'documents.updated',
    doc,
    data: mapDocument(doc),
  });
};
