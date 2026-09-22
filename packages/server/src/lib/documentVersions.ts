import { db } from '../db';
import { DomainError } from '../errors';
import { updateDocument } from './documents';
import {
  documentVersionStore,
  isWithdrawnConfig,
} from './documentVersionSnapshot';
import { emitDocumentRestored, isWithdrawn } from './documentWithdrawal';
import {
  type ArchivedVersionRow,
  configNumber,
  configObject,
  configString,
  makeVersionArchive,
  mapArchivedVersionFields,
  toResourceRef,
} from './resourceVersions';

/**
 * Document version history.
 *
 * The archive mechanics live in `resourceVersions.ts` and are shared with
 * agents, guardrails, orchestrations and workflows; this module supplies the
 * document-specific adapters. Versions are never written from here — they are
 * archived by the shared write path in `documents.ts`, so a REST edit, a
 * formation apply and a restore leave identical history.
 */

// ── Mapping ──────────────────────────────────────────────────────────────

export const mapDocumentVersion = (
  version: ArchivedVersionRow,
  documentPublicId: string
) => {
  return {
    document_id: documentPublicId,
    ...mapArchivedVersionFields(version),
  };
};

/** Loads the document a version belongs to, as the archive's reference shape. */
const loadDocumentRef = async (args: { id: string }) => {
  const document = await db.Document.findOne({
    where: { publicId: args.id },
  });

  /* istanbul ignore next -- every history route loads the document through
     `getDocument` and answers `404` before reaching here, so this guards the
     lib function's own contract rather than a path a request takes. */
  if (!document) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Document '${args.id}' not found.`
    );
  }

  return toResourceRef(document);
};

/**
 * An archived metadata bag, narrowed. Absent reads as cleared rather than
 * "leave as is", so a restore is a rollback and not a merge.
 */
const readMetadataConfig = (value: unknown): Record<string, unknown> | null => {
  const bag = configObject(value);
  return bag === null ? null : { ...bag };
};

/** An archived tag bag, narrowed. Absent reads as cleared, never "leave as is". */
const readTagConfig = (value: unknown): Record<string, string> | null => {
  const bag = configObject(value);
  if (!bag) return null;

  const tags: Record<string, string> = {};
  for (const [key, entry] of Object.entries(bag)) {
    if (typeof entry === 'string') tags[key] = entry;
  }
  return tags;
};

const CHUNK_STRATEGIES = ['page', 'whole', 'size'] as const;

type ChunkStrategyName = (typeof CHUNK_STRATEGIES)[number];

const readChunkStrategy = (value: unknown): ChunkStrategyName | undefined => {
  const name = configString(value);
  return CHUNK_STRATEGIES.includes(name as ChunkStrategyName)
    ? (name as ChunkStrategyName)
    : undefined;
};

/**
 * The document adapter over the shared archive.
 *
 * `applyConfig` routes through `updateDocument` rather than writing columns,
 * so a restored document is re-chunked and re-embedded on the ordinary path —
 * a restore that wrote the row directly would leave the index describing the
 * content the document no longer holds.
 */
const documentVersionArchive = makeVersionArchive({
  store: documentVersionStore,
  loadResource: (args) => {
    return loadDocumentRef({ id: args.id });
  },
  mapVersion: mapDocumentVersion,
  applyConfig: async (args) => {
    if (isWithdrawnConfig(args.config)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Document '${args.id}' version ${args.version} is a withdrawal, which has no content to restore. Restore version ${args.version - 1} instead.`,
        { document_id: args.id, version: args.version }
      );
    }

    const content = configString(args.config.content);
    /* istanbul ignore next -- every non-withdrawal config is built by
       `buildDocumentConfigSnapshot`, which always carries `content`, so a
       version without one means the row was edited outside the application. */
    if (content === null) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Document '${args.id}' has an archived version with no content.`
      );
    }

    const document = await loadDocumentRef({ id: args.id });
    const restored = await updateDocument({
      id: args.id,
      revivesWithdrawn: await isWithdrawn({ documentDbId: document.dbId }),
      content,
      title: configString(args.config.title),
      path: configString(args.config.path),
      metadata: readMetadataConfig(args.config.metadata),
      tags: readTagConfig(args.config.tags),
      chunkStrategy: readChunkStrategy(args.config.chunk_strategy),
      chunkSize: configNumber(args.config.chunk_size) ?? undefined,
      chunkOverlap: configNumber(args.config.chunk_overlap) ?? undefined,
      versionLabel: args.label,
      createdByUserId: args.createdByUserId,
    });

    /* istanbul ignore next -- the archive loaded the document to find the
       version, so it exists by the time this runs. */
    if (!restored) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Document '${args.id}' not found.`
      );
    }

    return restored;
  },
});

// ── Read endpoints ───────────────────────────────────────────────────────

export const listDocumentVersions = async (args: {
  documentId: string;
  limit?: number;
  offset?: number;
}) => {
  return documentVersionArchive.listVersions({
    resourceId: args.documentId,
    limit: args.limit,
    offset: args.offset,
  });
};

export const getDocumentVersion = async (args: {
  documentId: string;
  version: number;
}) => {
  return documentVersionArchive.getVersion({
    resourceId: args.documentId,
    version: args.version,
  });
};

export const restoreDocumentVersion = async (args: {
  documentId: string;
  version: number;
  label?: string | null;
  createdByUserId?: number | null;
}) => {
  const document = await loadDocumentRef({ id: args.documentId });
  const withdrawn = await isWithdrawn({ documentDbId: document.dbId });

  // Appends a new version rather than rewinding the counter, so a run citing
  // any version in between still resolves.
  const restored = await documentVersionArchive.restoreVersion({
    resourceId: args.documentId,
    version: args.version,
    label: args.label,
    createdByUserId: args.createdByUserId,
  });

  if (withdrawn) {
    await emitDocumentRestored({ id: args.documentId });
  }

  return restored;
};
