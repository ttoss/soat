import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import type { ChunkStrategy } from './chunking';
import {
  applyDocumentChunkChanges,
  chunkDocumentText,
  createDocumentTextFile,
  readFileContent,
} from './documentContent';
import { type DocumentFiling, resolveDocumentFiling } from './documentFiling';
import {
  emitDocumentLifecycleEvent,
  fetchDocumentByIdWithContext,
  fetchDocumentWithContext,
} from './documentLoaders';
import { mapDocument } from './documentMapper';
import {
  buildDocumentConfigSnapshot,
  documentVersionStore,
} from './documentVersionSnapshot';
import {
  assertCallerPath,
  normalizePath,
  pathPrefixPattern,
} from './filePaths';
import { getStorageProvider } from './fileStorage';
import { recoverStaleDocument } from './ingestionCallback';
import {
  assertCreatedDocumentMetadataValid,
  assertUpdatedDocumentMetadataValid,
} from './metadataSchemas';
import { emptyPage, paginatedList } from './pagination';
import { registerResourceFieldMap } from './policyCompiler';
import { hasPolicyConstraints, referencesAssociation } from './policyWhere';
import { toResourceRef } from './resourceVersions';
import {
  applyMetadataWhere,
  compileMetadataWhere,
  type MetadataFilter,
} from './structuredFilter';
import { liveDocumentWhere, nonSystemPathWhere } from './systemPathScope';
import { applyTagFilter, hasSystemTagFilter, mergeTags } from './tags';
import type { VersionedWrite } from './writePrecondition';

export {
  enqueueDocumentIngestion,
  reingestDocument,
} from './documentIngestion';
export { completeIngestionCallback } from './ingestionCallback';
export type {
  DocumentQueryConfig,
  QueryDocumentResult,
} from './knowledgeDocuments';

const log = createDebug('soat:documents');

registerResourceFieldMap({
  resourceType: 'document',
  publicIdColumn: { column: 'publicId' },
  pathColumn: { column: 'path', alias: 'file' },
  tagsColumn: { column: 'tags' },
});

/**
 * The listing roots at `Document`, so a raw comparison on the bag names that
 * alias. Sequelize qualifies the containment halves itself; only the ordering
 * fragments spell the column.
 */
const DOCUMENT_METADATA_COLUMN = '"Document"."metadata"';

const buildDocumentQueryOptions = (args: {
  projectIds?: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
  pathPrefix?: string;
  tags?: Record<string, string>;
  metadataWhere: unknown[];
  includeWithdrawn?: boolean;
  limit: number;
  offset: number;
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topLevelWhere: Record<string, any> = hasPolicyConstraints(
    args.policyWhere
  )
    ? { ...args.policyWhere }
    : {};
  if (!args.includeWithdrawn) Object.assign(topLevelWhere, liveDocumentWhere());
  applyTagFilter({ where: topLevelWhere, tags: args.tags });
  applyMetadataWhere({ where: topLevelWhere, fragments: args.metadataWhere });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const file: Record<string, any> = {};
  if (args.projectIds !== undefined) file.projectId = args.projectIds;
  if (args.pathPrefix !== undefined) {
    file.path = { [Op.like]: pathPrefixPattern(args.pathPrefix) };
  } else if (!hasSystemTagFilter(args.tags)) {
    Object.assign(file, nonSystemPathWhere());
  }
  const fileWhere = Reflect.ownKeys(file).length > 0 ? file : undefined;
  return {
    topLevelWhere,
    fileWhere,
    subQuery: referencesAssociation(args.policyWhere) ? false : undefined,
  };
};

export const listDocuments = async (args: {
  projectIds?: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
  /** Only documents filed under this directory (see `pathPrefixPattern`). */
  pathPrefix?: string;
  tags?: Record<string, string>;
  /** Structured question about the bag; see {@link compileMetadataWhere}. */
  metadata?: MetadataFilter;
  /** Withdrawn documents are left out unless the request asks for them. */
  includeWithdrawn?: boolean;
  limit?: number;
  offset?: number;
}) => {
  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return emptyPage(args);
  }

  const metadataWhere = compileMetadataWhere({
    filter: args.metadata,
    column: DOCUMENT_METADATA_COLUMN,
  });

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      const { topLevelWhere, fileWhere, subQuery } = buildDocumentQueryOptions({
        projectIds: args.projectIds,
        policyWhere: args.policyWhere,
        pathPrefix: args.pathPrefix,
        tags: args.tags,
        metadataWhere,
        includeWithdrawn: args.includeWithdrawn,
        limit,
        offset,
      });

      return db.Document.findAndCountAll({
        distinct: true,
        where:
          Reflect.ownKeys(topLevelWhere).length > 0 ? topLevelWhere : undefined,
        include: [
          {
            model: db.File,
            as: 'file',
            where: fileWhere,
            include: [{ model: db.Project, as: 'project' }],
          },
        ],
        subQuery,
        limit,
        offset,
      });
    },
    map: mapDocument,
  });
};

export const getDocumentSourceContent = async (args: {
  id: string;
}): Promise<string | null> => {
  const doc = await fetchDocumentWithContext(args.id);
  if (!doc) return null;
  return readFileContent(doc.file);
};

export const getDocument = async (args: { id: string }) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) return null;

  await recoverStaleDocument(doc);

  const mapped = mapDocument(doc);

  const chunks = await db.DocumentChunk.findAll({
    where: { documentId: doc.id },
    order: [['chunkIndex', 'ASC']],
  });

  if (chunks.length > 0) {
    const content = chunks
      .map((c) => {
        return c.content;
      })
      .join('\n');
    return { ...mapped, content };
  }

  // Fallback: try reading from file for legacy documents without chunks
  const content = await readFileContent(doc.file);
  return { ...mapped, content };
};

export const createDocument = async (
  args: {
    projectId: number;
    content: string;
    path?: string;
    filename?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
    chunkStrategy?: ChunkStrategy;
    chunkSize?: number;
    chunkOverlap?: number;
    /** Files the document under the reserved root. See {@link DocumentFiling}. */
    system?: DocumentFiling;
    /** Off stores the chunks without vectors. See `persistChunks`. */
    embed?: boolean;
  } & VersionedWrite
) => {
  log('createDocument: projectId=%d', args.projectId);

  // Minted here rather than by the model hook: the reserved-root key contains
  // it, and the backing File row is written first.
  const publicId = generatePublicId(PUBLIC_ID_PREFIXES.document);
  const filing = resolveDocumentFiling({
    system: args.system,
    path: args.path,
    filename: args.filename,
    publicId,
  });

  await assertCreatedDocumentMetadataValid({
    projectId: args.projectId,
    path: filing.normalizedPath,
    metadata: args.metadata,
  });

  const file = await createDocumentTextFile({
    projectId: args.projectId,
    content: args.content,
    normalizedPath: filing.normalizedPath,
    filename: filing.filename,
  });

  const doc = await db.Document.create({
    publicId,
    fileId: file.id,
    title: args.title ?? null,
    metadata: args.metadata ? args.metadata : null,
    tags: args.tags ?? null,
    chunkStrategy: args.chunkStrategy ?? null,
    chunkSize: args.chunkSize ?? null,
    chunkOverlap: args.chunkOverlap ?? null,
  });

  await chunkDocumentText({
    documentId: doc.id as number,
    projectId: args.projectId,
    content: args.content,
    chunkStrategy: args.chunkStrategy,
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
    embed: args.embed,
  });

  const created = await fetchDocumentByIdWithContext(doc.id as number);
  const mapped = mapDocument(created!);

  // Version 1 is the state the document was created in, archived so a later
  // restore has something to go back to and a withdrawal has content to
  // restore from.
  await documentVersionStore.writeVersion({
    resourceDbId: doc.id as number,
    version: 1,
    config: buildDocumentConfigSnapshot({
      document: mapped,
      content: args.content,
    }),
    label: args.versionLabel,
    createdByUserId: args.createdByUserId,
  });

  emitDocumentLifecycleEvent({
    type: 'documents.created',
    doc: created!,
    data: mapped,
  });

  return mapped;
};

export const deleteDocument = async (args: { id: string }) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) return null;

  const file = doc.file;
  if (file?.storagePath) {
    const provider = getStorageProvider({ storageType: file.storageType });
    await provider.delete({ storagePath: file.storagePath });
  }

  const docPublicId = doc.publicId;
  // Archives are owned by their document, so they go first and no orphan row
  // is left behind. `DELETE` is the permanent act; withdrawal is the one that
  // keeps the history.
  await documentVersionStore.deleteVersions({ resourceDbId: doc.id as number });
  await doc.destroy();
  if (doc.file) {
    await doc.file.destroy();
  }

  emitDocumentLifecycleEvent({
    type: 'documents.deleted',
    doc,
    data: { id: docPublicId },
  });

  return true;
};

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

/** A stated `path`, normalized and refused when it names the reserved root. */
const normalizeStatedPath = (path: string | null): string | null => {
  return assertCallerPath(path === null ? null : normalizePath(path));
};

export const updateDocument = async (
  args: {
    id: string;
    content?: string;
    /** `null` clears the field; absent leaves it as it is. */
    title?: string | null;
    path?: string | null;
    metadata?: Record<string, unknown> | null;
    tags?: Record<string, string> | null;
    chunkStrategy?: ChunkStrategy;
    chunkSize?: number;
    chunkOverlap?: number;
  } & VersionedWrite
) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) return null;

  // Runtime-written documents are read-only for callers: their content is the
  // record another module keeps, and editing it would rewrite that module's
  // history behind its back.
  assertCallerPath(doc.file?.path);

  /* istanbul ignore else -- the backing file is optional in the loaded type and
     always present in practice; without one there is no project to judge
     against and no path to judge under. */
  if (doc.file) {
    await assertUpdatedDocumentMetadataValid({
      projectId: doc.file.projectId,
      currentPath: doc.file.path ?? null,
      path:
        args.path === undefined ? undefined : normalizeStatedPath(args.path),
      metadata: args.metadata,
      currentMetadata: doc.metadata ?? null,
    });
  }

  const before = buildDocumentConfigSnapshot({
    document: mapDocument(doc),
    content: await readFileContent(doc.file),
  });

  // Re-chunking and the storage rewrite happen before the commit rather than
  // inside it. Neither is transactional — one calls the embedding provider and
  // the other writes an object store — so the transaction is scoped to what it
  // can actually cover: the row's columns, the version bump and the archive.
  await applyDocumentChunkChanges({
    doc,
    content: args.content,
    chunkStrategy: args.chunkStrategy,
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
  });

  if (args.path !== undefined && doc.file) {
    await doc.file.update({ path: normalizeStatedPath(args.path) });
  }

  let refreshed = doc;
  await documentVersionStore.commitConfigChange({
    resource: toResourceRef(doc),
    expectedVersion: args.expectedVersion,
    before,
    label: args.versionLabel,
    createdByUserId: args.createdByUserId,
    applyWrite: async ({ transaction }) => {
      const updates = buildDocumentColumnUpdates(args);
      if (Object.keys(updates).length > 0) {
        await doc.update(updates, { transaction });
      }

      refreshed = (await fetchDocumentByIdWithContext(
        doc.id as number,
        transaction
      ))!;

      return {
        row: refreshed,
        after: buildDocumentConfigSnapshot({
          document: mapDocument(refreshed),
          content: await readFileContent(refreshed.file),
        }),
      };
    },
  });

  // Mapped after the commit so the response carries the bumped version.
  const mapped = mapDocument(refreshed);

  emitDocumentLifecycleEvent({
    type: 'documents.updated',
    doc: refreshed,
    data: mapped,
  });

  return mapped;
};

export const getDocumentTags = async (args: { id: string }) => {
  const doc = await db.Document.findOne({ where: { publicId: args.id } });
  if (!doc) return null;
  return doc.tags ?? {};
};

export const updateDocumentTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const doc = await fetchDocumentWithContext(args.id);

  if (!doc) return null;

  // A document the runtime filed is its record of a turn, not a caller's bag
  // to relabel — and a replaceable tag would not be a marker at all.
  assertCallerPath(doc.file?.path);

  const newTags = mergeTags({
    current: doc.tags,
    incoming: args.tags,
    merge: args.merge,
  });

  await doc.update({ tags: newTags });

  const refreshed = await fetchDocumentByIdWithContext(doc.id as number);
  const tagsMapped = mapDocument(refreshed!);

  emitDocumentLifecycleEvent({
    type: 'documents.updated',
    doc: refreshed!,
    data: tagsMapped,
  });

  // The tag routes' contract is the tag map itself, not the document.
  return newTags;
};

export { getDocumentStatus } from './documentStatus';
