import type { MemorySource } from '@soat/postgresdb';
import { db } from 'src/db';
import { assertCorpusWriteQuotas } from 'src/lib/corpusWriteQuotas';
import type { MemoryAssertionSource } from 'src/lib/memoryAssertions';
import { recordMemoryAssertion } from 'src/lib/memoryAssertions';
import { resolveMemoryContent } from 'src/lib/memoryContents';
import { mapMemory, memories, memoryIncludes } from 'src/lib/memoryMapper';
import { validMemoryWhere } from 'src/lib/memoryValidity';
import { paginatedList } from 'src/lib/pagination';
import { registerResourceFieldMap } from 'src/lib/policyCompiler';
import { hasPolicyConstraints } from 'src/lib/policyWhere';
import { assertStorageQuota, contentBytes } from 'src/lib/quotaStorage';
import { applyTagFilter } from 'src/lib/tags';
import {
  assertWritePrecondition,
  versionConflict,
} from 'src/lib/writePrecondition';

// A memory is addressed as `srn:<project>:memory:<id>`; its store is a
// separate resource type (`memory_store`), so a policy can govern the two
// independently.
registerResourceFieldMap({
  resourceType: 'memory',
  publicIdColumn: { column: 'publicId' },
  tagsColumn: { column: 'tags' },
});

export { mapMemory, memoryIncludes } from 'src/lib/memoryMapper';
export type { MemoryWriteAction, MemoryWriteResult } from 'src/lib/memoryWrite';
export {
  DEFAULT_DUPLICATE_THRESHOLD,
  DEFAULT_SUPERSEDE_THRESHOLD,
  findThresholdOrderError,
  resolveMemoryThresholds,
  writeMemory,
} from 'src/lib/memoryWrite';

/**
 * The project a memory store's embeddings are billed to and its rows are
 * counted against.
 */
const resolveMemoryStoreProjectId = async (args: {
  memoryStoreId: number;
}): Promise<number | null> => {
  const memoryStore = await db.MemoryStore.findByPk(args.memoryStoreId, {
    attributes: ['projectId'],
  });
  return memoryStore?.projectId ?? null;
};

/**
 * The `storage_bytes` cap alone, for a memory rule's firing: it runs after the
 * turn, so it has nothing in flight to break, but its embedding is a run's and
 * exempt from the spend budget.
 */
export const assertMemoryStorageQuota = async (args: {
  memoryStoreId: number;
  content: string;
}): Promise<void> => {
  const projectId = await resolveMemoryStoreProjectId({
    memoryStoreId: args.memoryStoreId,
  });
  if (projectId == null) return;
  await assertStorageQuota({
    projectId,
    addedBytes: contentBytes(args.content),
  });
};

/**
 * Both corpus caps on a caller-driven write. Never called from `writeMemory`:
 * the `write_memory` tool reaches it mid-turn, and the caps are a
 * request-boundary refusal that must not fail a generation under way.
 */
export const assertMemoryWriteQuotas = async (args: {
  memoryStoreId: number;
  content: string;
}): Promise<void> => {
  const projectId = await resolveMemoryStoreProjectId({
    memoryStoreId: args.memoryStoreId,
  });
  if (projectId == null) return;
  await assertCorpusWriteQuotas({
    projectId,
    addedBytes: contentBytes(args.content),
  });
};

/**
 * A declared memory, written without the dedup algorithm: a formation template
 * states what must exist, so the apply creates it rather than resolving it
 * against what is already there. It still appends its assertion — the ledger
 * records every write, whichever door it came through.
 */
export const createMemory = async (args: {
  memoryStoreId: number;
  content: string;
  sourceType?: MemorySource;
  sourceId?: string | null;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
  assertion: MemoryAssertionSource;
}) => {
  const content = await resolveMemoryContent({
    memoryStoreId: args.memoryStoreId,
    content: args.content,
    projectId: await resolveMemoryStoreProjectId({
      memoryStoreId: args.memoryStoreId,
    }),
    generationId: args.assertion.generationId,
  });

  const entry = await db.Memory.create({
    memoryStoreId: args.memoryStoreId,
    contentId: content.id as number,
    sourceType: args.sourceType ?? 'manual',
    sourceId: args.sourceId ?? null,
    tags: args.tags ?? null,
    metadata: args.metadata ?? null,
  });

  await recordMemoryAssertion({
    memoryStoreId: args.memoryStoreId,
    contentId: content.id as number,
    memoryId: entry.id as number,
    outcome: 'created',
    // Nothing was compared: this door does not dedup.
    similarity: null,
    source: args.assertion,
  });

  return mapMemory(await memories.reload(entry));
};

export const listMemories = async (args: {
  memoryStoreId: number;
  limit?: number;
  cursor?: string;
  /** Invalidated (superseded) memories are excluded unless this is set. */
  includeInvalidated?: boolean;
  tags?: Record<string, string>;
  policyWhere?: Record<string, unknown>;
}) => {
  const where: Record<string, unknown> = {
    memoryStoreId: args.memoryStoreId,
    ...(args.includeInvalidated ? {} : validMemoryWhere()),
  };
  applyTagFilter({ where, tags: args.tags });
  if (hasPolicyConstraints(args.policyWhere)) {
    Object.assign(where, args.policyWhere);
  }
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: {
      memoryStoreId: args.memoryStoreId,
      includeInvalidated: args.includeInvalidated,
      tags: args.tags,
    },
    where,
    order: [['createdAt', 'ASC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.Memory.findAll({
        where: pageWhere,
        include: memoryIncludes(),
        order,
        limit,
      });
    },
    map: mapMemory,
  });
};

/**
 * Reads a single memory regardless of validity — a superseded memory stays
 * addressable by id so the supersede chain can be walked for audit.
 */
export const getMemory = async (args: { id: string }) => {
  const entry = await db.Memory.findOne({
    where: { publicId: args.id },
    include: memoryIncludes(),
  });
  if (!entry) return null;
  return mapMemory(entry);
};

/** The internal id, for the assertion route, which queries by foreign key. */
export const findMemoryRowId = async (args: {
  id: string;
}): Promise<number | null> => {
  const entry = await db.Memory.findOne({
    where: { publicId: args.id },
    attributes: ['id'],
  });
  return (entry?.id as number | undefined) ?? null;
};

/** The internal id of the store holding a memory, which the quota checks take. */
export const findMemoryStoreRowId = async (args: {
  memoryId: string;
}): Promise<number | null> => {
  const entry = await db.Memory.findOne({
    where: { publicId: args.memoryId },
    attributes: ['memoryStoreId'],
  });
  return (entry?.memoryStoreId as number | undefined) ?? null;
};

export const updateMemory = async (args: {
  id: string;
  content?: string;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
  /** `null`/absent states no precondition; see {@link readWritePrecondition}. */
  expectedVersion?: number | null;
}) => {
  const entry = await db.Memory.findOne({
    where: { publicId: args.id },
  });
  if (!entry) return null;

  // Checked before any field is touched: a caller writing against a version
  // that has already moved is refused whether or not its change would have
  // altered anything.
  assertWritePrecondition({
    expectedVersion: args.expectedVersion,
    currentVersion: entry.version,
    resourceLabel: 'Memory',
    resourceId: entry.publicId,
  });

  const updates: Record<string, unknown> = {};

  if (args.content !== undefined) {
    // Re-points at the store's row for the new text rather than rewriting the
    // old one: that row may be shared with other memories and is named by
    // every assertion that stated it, so editing it in place would silently
    // rewrite history and other memories alike.
    const content = await resolveMemoryContent({
      memoryStoreId: entry.memoryStoreId,
      content: args.content,
      projectId: await resolveMemoryStoreProjectId({
        memoryStoreId: entry.memoryStoreId,
      }),
      // An edit through the API runs for no generation.
      generationId: null,
    });
    updates.contentId = content.id as number;
  }

  if (args.tags !== undefined) {
    updates.tags = args.tags;
  }

  if (args.metadata !== undefined) {
    updates.metadata = args.metadata;
  }

  // A conditional `UPDATE`, never a read-then-write: the loser of a race
  // learns it lost from the statement's own row count rather than from a
  // comparison against a value that may already be stale.
  const currentVersion = entry.version;
  const [claimed] = await db.Memory.update(
    { ...updates, version: currentVersion + 1 },
    { where: { id: entry.id, version: currentVersion } }
  );

  if (claimed === 0) {
    const live = await db.Memory.findOne({ where: { id: entry.id } });
    throw versionConflict({
      currentVersion: live?.version ?? currentVersion,
      expectedVersion: args.expectedVersion ?? null,
      resourceLabel: 'Memory',
      resourceId: entry.publicId,
    });
  }

  return mapMemory(await memories.reload(entry));
};

export const deleteMemory = async (args: {
  id: string;
}): Promise<'deleted' | null> => {
  const entry = await db.Memory.findOne({
    where: { publicId: args.id },
  });
  if (!entry) return null;
  await entry.destroy();
  return 'deleted';
};
