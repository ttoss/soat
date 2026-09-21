import { db } from '../db';
import {
  type ConfigSnapshot,
  makeVersionStore,
  projectConfigSnapshot,
} from './resourceVersions';

/**
 * How a document's content and annotations are projected into, and read back
 * out of, the shared version archive (`resourceVersions.ts`). Everything
 * generic — the projection mechanics, the change detection, the conditional
 * commit — lives there.
 *
 * This module holds the archive's **write side** so that `documents.ts` can
 * reach it without importing `documentVersions.ts`, which imports
 * `documents.ts` back for `updateDocument`.
 */

export const documentVersionStore = makeVersionStore({
  resourceLabel: 'Document',
  versionModel: () => {
    return db.DocumentVersion;
  },
  resourceModel: () => {
    return db.Document;
  },
  foreignKey: 'documentId',
});

/** A document's archived configuration, in the wire shape the spec documents. */
export type DocumentConfigSnapshot = ConfigSnapshot;

/**
 * The key a tombstone version is recognised by.
 *
 * A withdrawal is a version with this set and no content, rather than a
 * `deleted_at` column: one mechanism already answers "what does this document
 * hold now", and a second marker would need every reader to carry a second
 * exclusion — which is the drift that leaves a withdrawn document reachable
 * from whichever reader was missed.
 */
export const WITHDRAWN_CONFIG_KEY = 'withdrawn';

/**
 * Fields on a document's wire shape that describe the row rather than its
 * content, so a write that only moves them takes no version.
 *
 * `status`, `size` and `content_type` are the ingestion pipeline's and the
 * backing file's; `file_id` and `project_id` are identity. Stated as an
 * exclusion, so a field added to the mapper is archived by default and a
 * restore keeps working.
 */
const NON_CONFIG_DOCUMENT_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'file_id',
  'project_id',
  'version',
  'status',
  'filename',
  'content_type',
  'size',
  'created_at',
  'updated_at',
]);

/**
 * The document's versioned surface: its content plus the annotations and chunk
 * configuration that decide how that content is indexed.
 *
 * `content` is passed in rather than read off the mapped document, because the
 * list and get mappers differ on whether they carry it and a snapshot that
 * silently omitted it would restore an empty document.
 */
export const buildDocumentConfigSnapshot = (args: {
  document: Record<string, unknown>;
  content: string | null;
}): DocumentConfigSnapshot => {
  return {
    ...projectConfigSnapshot({
      resource: args.document,
      nonConfigFields: NON_CONFIG_DOCUMENT_FIELDS,
    }),
    content: args.content,
  };
};

/** The snapshot a withdrawal archives: the fact, and nothing of the content. */
export const buildWithdrawnConfigSnapshot = (): DocumentConfigSnapshot => {
  return { [WITHDRAWN_CONFIG_KEY]: true };
};

/** True when this archived version is a withdrawal rather than a content state. */
export const isWithdrawnConfig = (config: ConfigSnapshot): boolean => {
  return config[WITHDRAWN_CONFIG_KEY] === true;
};
