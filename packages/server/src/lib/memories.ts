import type { MemorySource } from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import { db } from 'src/db';
import { getEmbedding } from 'src/lib/embedding';
import { pickMergedContent } from 'src/lib/memoryConsolidation';
import * as consolidationCompletion from 'src/lib/memoryConsolidationCompletion';
import { paginatedList } from 'src/lib/pagination';
import { registerResourceFieldMap } from 'src/lib/policyCompiler';
import { hasPolicyConstraints } from 'src/lib/policyWhere';
import { assertStorageQuota, contentBytes } from 'src/lib/quotaStorage';
import { makeResourceAccessor } from 'src/lib/resourceAccessor';
import { applyTagFilter, mergeTags } from 'src/lib/tags';
import { withIterativeVectorScan } from 'src/lib/vectorSearch';

// A memory is addressed as `srn:<project>:memory:<id>`; its store is a
// separate resource type (`memory_store`), so a policy can govern the two
// independently.
registerResourceFieldMap({
  resourceType: 'memory',
  publicIdColumn: { column: 'publicId' },
  tagsColumn: { column: 'tags' },
});

/**
 * Context needed to consolidate a merge with an LLM. Present only for writes
 * with an agent context (the `write_memory` tool and automatic extraction);
 * absent for manual REST writes, which have no model to consolidate with and
 * therefore never merge.
 */
export type MemoryConsolidationContext = {
  agentId: string;
  projectIds?: number[];
  aiProviderId?: string;
  model?: string;
};

type MemoryRow = InstanceType<(typeof db)['Memory']> & {
  memoryStore?: InstanceType<(typeof db)['MemoryStore']>;
  supersededByMemory?: InstanceType<(typeof db)['Memory']> | null;
};

/**
 * Every read path that feeds `mapMemory` must use these includes: the
 * mapper reports the store and supersede links from the loaded associations,
 * so a query that omits one would silently return `null` for a link that
 * exists (the #801 failure shape).
 */
const memoryIncludes = () => {
  return [
    { model: db.MemoryStore, as: 'memoryStore' },
    { model: db.Memory, as: 'supersededByMemory' },
  ];
};

const memories = makeResourceAccessor<MemoryRow>({
  model: () => {
    return db.Memory;
  },
  includes: memoryIncludes,
  label: 'Memory',
});

const linkedPublicId = (
  linked?: { publicId: string } | null
): string | null => {
  return linked?.publicId ?? null;
};

const mapMemory = (instance: MemoryRow) => {
  return {
    id: instance.publicId,
    memory_store_id: instance.memoryStore?.publicId,
    content: instance.content,
    source_type: instance.sourceType,
    source_id: instance.sourceId ?? null,
    tags: instance.tags ?? null,
    metadata: instance.metadata ?? null,
    invalidated_at: instance.invalidatedAt ?? null,
    superseded_by_memory_id: linkedPublicId(instance.supersededByMemory),
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

/**
 * Merges the incoming entry's tags/metadata into an existing entry during a
 * consolidation write, so tags accumulate rather than being lost. Both are
 * shallow-merged with incoming keys winning — the same rule every other
 * tagged resource applies through `mergeTags`.
 */
const mergeEntryTags = (args: {
  existing: Record<string, string> | null;
  incoming?: Record<string, string> | null;
}): Record<string, string> | null => {
  if (!args.incoming || Object.keys(args.incoming).length === 0) {
    return args.existing;
  }
  return mergeTags({
    current: args.existing,
    incoming: args.incoming,
    merge: true,
  });
};

const mergeEntryMetadata = (args: {
  existing: Record<string, unknown> | null;
  incoming?: Record<string, unknown> | null;
}): Record<string, unknown> | null => {
  if (!args.incoming) return args.existing;
  return { ...(args.existing ?? {}), ...args.incoming };
};

/**
 * The project a memory store's embeddings are billed to. A memory is addressed
 * by its memory store, never by a project, so the owner is read here rather than
 * threaded through the six write paths that reach these functions.
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
 * The project's `storage_bytes` cap applied to a caller-driven entry write.
 *
 * Called from the REST route and the formation resource rather than from
 * `writeMemory` itself: the `write_memory` tool and automatic extraction
 * both reach that function mid-turn, and a refusal there would fail a
 * generation already under way — the corpus cap is a request-boundary refusal
 * by design (#1249).
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

const findTopSimilarEntry = async (args: {
  memoryStoreId: number;
  embeddingLiteral: string;
}) => {
  // Every filter here is applied *after* the HNSW index proposes candidates, so
  // without an iterative scan a crowded index can hide this memory store's own match
  // and the write falls through to create a near-duplicate.
  return withIterativeVectorScan({
    run: ({ transaction }) => {
      return db.Memory.findOne({
        where: {
          memoryStoreId: args.memoryStoreId,
          embedding: { [Op.not]: null },
          // A retired fact is not a dedup candidate: a write that restates
          // superseded knowledge must land as a new entry, not merge into the
          // entry that was invalidated precisely because it no longer holds.
          invalidatedAt: null,
        },
        attributes: {
          include: [
            [
              db.Memory.sequelize!.literal(
                `"Memory"."embedding" <=> '${args.embeddingLiteral}'`
              ),
              'distance',
            ],
          ],
        },
        // The includes join memories to itself (`supersededByMemory`), so a
        // bare `embedding` in the literals below is ambiguous — both sides of that
        // join have the column. Qualify with the table alias.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        include: memoryIncludes() as any,
        order: db.Memory.sequelize!.literal(
          `"Memory"."embedding" <=> '${args.embeddingLiteral}'`
        ),
        transaction,
      });
    },
  });
};

/**
 * Consolidates a merge-band write into the existing entry, or returns `null`
 * when there is nothing to consolidate with and the caller must create one.
 *
 * There is deliberately no concatenation path: appending turns a one-fact entry
 * into a paragraph whose embedding drifts from each fact it contains, degrading
 * the similarity decision the thresholds depend on. Removed in #1062 — a merge
 * now happens only when a model rewrites the two facts into one.
 *
 * `null` means "create" on both its paths — a write with no agent context has
 * no model to call, and a failed consolidation must still not lose the fact.
 * The cost is a possible near-duplicate until arbitration merges it.
 */
const mergeAndUpdateEntry = async (args: {
  match: Awaited<ReturnType<typeof findTopSimilarEntry>>;
  incoming: string;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
  consolidation?: MemoryConsolidationContext;
}): Promise<ReturnType<typeof mapMemory> | null> => {
  const match = args.match!;

  if (!args.consolidation) return null;

  let mergedContent: string | null;
  try {
    const consolidated =
      await consolidationCompletion.runConsolidationCompletion({
        agentId: args.consolidation.agentId,
        projectIds: args.consolidation.projectIds,
        existing: match.content,
        incoming: args.incoming,
        aiProviderId: args.consolidation.aiProviderId,
        model: args.consolidation.model,
      });
    mergedContent = pickMergedContent({ consolidated });
  } catch {
    return null;
  }
  if (mergedContent === null) return null;

  match.content = mergedContent;
  match.tags = mergeEntryTags({ existing: match.tags, incoming: args.tags });
  match.metadata = mergeEntryMetadata({
    existing: match.metadata,
    incoming: args.metadata,
  });
  try {
    match.embedding = await getEmbedding({
      text: mergedContent,
      projectId: await resolveMemoryStoreProjectId({
        memoryStoreId: match.memoryStoreId,
      }),
    });
  } catch {
    // embedding is optional
  }

  await match.save();

  return mapMemory(await memories.reload(match));
};

type WriteMemoryResult = {
  action: 'created' | 'updated' | 'skipped';
  entry: ReturnType<typeof mapMemory>;
};

/**
 * Finds the most similar existing entry and decides whether the incoming write
 * is a duplicate (skip) or a related fact (merge). Returns the resolved result,
 * or null when no similar entry exists and the caller should create a new one.
 */
const resolveDedupAction = async (args: {
  memoryStoreId: number;
  content: string;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
  duplicateThreshold?: number;
  updateThreshold?: number;
  consolidation?: MemoryConsolidationContext;
  embedding: number[] | null;
}): Promise<WriteMemoryResult | null> => {
  if (!args.embedding) return null;

  const duplicateThreshold = args.duplicateThreshold ?? 0.95;
  const updateThreshold = args.updateThreshold ?? 0.75;
  const embeddingLiteral = `[${args.embedding.join(',')}]`;
  const topMatch = await findTopSimilarEntry({
    memoryStoreId: args.memoryStoreId,
    embeddingLiteral,
  });
  if (!topMatch) return null;

  const distance = parseFloat(
    (topMatch.getDataValue('distance') as string) ?? '1'
  );
  const score = 1 - distance;

  // Step 3a: Duplicate — skip
  if (score >= duplicateThreshold) {
    return { action: 'skipped', entry: mapMemory(topMatch) };
  }

  // Step 3b: Related — merge, but only where an LLM can consolidate the two
  // facts into one. Everywhere else (no agent context, or a failed completion)
  // this returns null and the write falls through to create.
  if (score >= updateThreshold) {
    const entry = await mergeAndUpdateEntry({
      match: topMatch,
      incoming: args.content,
      tags: args.tags,
      metadata: args.metadata,
      consolidation: args.consolidation,
    });
    if (entry) return { action: 'updated', entry };
  }

  return null;
};

export const writeMemory = async (args: {
  memoryStoreId: number;
  content: string;
  sourceType?: MemorySource;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
  duplicateThreshold?: number;
  /**
   * Floor of the merge band. Only reachable with a `consolidation` context —
   * no wire surface sets it, because a caller without an agent context always
   * creates (#1062).
   */
  updateThreshold?: number;
  consolidation?: MemoryConsolidationContext;
  /**
   * The conversation this fact was learned in, as a public id. Supplied by the
   * extraction path when a turn belongs to a conversation; absent everywhere
   * else, which is what makes those writes `manual`.
   *
   * Recorded on creation only. A merge leaves the existing memory's provenance
   * alone: it names the conversation that first asserted the fact, and that is
   * exactly the unbackfillable record this column exists to keep. A later turn
   * that genuinely replaces the fact supersedes it with a new memory (Memories
   * 5a), which carries its own provenance.
   */
  sourceConversationPublicId?: string;
}): Promise<WriteMemoryResult> => {
  // Step 1: Generate embedding for incoming content
  let embedding: number[] | null = null;
  try {
    embedding = await getEmbedding({
      text: args.content,
      projectId: await resolveMemoryStoreProjectId({
        memoryStoreId: args.memoryStoreId,
      }),
    });
  } catch {
    // embedding is optional
  }

  // Step 2 & 3: dedup/merge against the most similar existing entry
  const deduped = await resolveDedupAction({ ...args, embedding });
  if (deduped) return deduped;

  // Step 3c: New — create
  const conversationPublicId = args.sourceConversationPublicId ?? null;

  const entry = await db.Memory.create({
    memoryStoreId: args.memoryStoreId,
    content: args.content,
    sourceType: conversationPublicId
      ? 'conversation'
      : (args.sourceType ?? 'manual'),
    sourceId: conversationPublicId,
    tags: args.tags ?? null,
    metadata: args.metadata ?? null,
    embedding,
  });

  return {
    action: 'created',
    entry: mapMemory(await memories.reload(entry)),
  };
};

export const createMemory = async (args: {
  memoryStoreId: number;
  content: string;
  sourceType?: MemorySource;
  sourceId?: string | null;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
}) => {
  let embedding: number[] | null = null;

  try {
    embedding = await getEmbedding({
      text: args.content,
      projectId: await resolveMemoryStoreProjectId({
        memoryStoreId: args.memoryStoreId,
      }),
    });
  } catch {
    // embedding is optional — continue without it
  }

  const entry = await db.Memory.create({
    memoryStoreId: args.memoryStoreId,
    content: args.content,
    sourceType: args.sourceType ?? 'manual',
    sourceId: args.sourceId ?? null,
    tags: args.tags ?? null,
    metadata: args.metadata ?? null,
    embedding,
  });

  return mapMemory(await memories.reload(entry));
};

export const listMemories = async (args: {
  memoryStoreId: number;
  limit?: number;
  offset?: number;
  /** Invalidated (superseded) entries are excluded unless this is set. */
  includeInvalidated?: boolean;
  tags?: Record<string, string>;
  policyWhere?: Record<string, unknown>;
}) => {
  const where: Record<string, unknown> = {
    memoryStoreId: args.memoryStoreId,
    ...(args.includeInvalidated ? {} : { invalidatedAt: null }),
  };
  applyTagFilter({ where, tags: args.tags });
  if (hasPolicyConstraints(args.policyWhere)) {
    Object.assign(where, args.policyWhere);
  }
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Memory.findAndCountAll({
        where,
        include: memoryIncludes(),
        order: [['createdAt', 'ASC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapMemory,
  });
};

/**
 * Reads a single entry regardless of validity — a superseded entry stays
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

export const updateMemory = async (args: {
  id: string;
  content?: string;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
}) => {
  const entry = await db.Memory.findOne({
    where: { publicId: args.id },
  });
  if (!entry) return null;

  if (args.content !== undefined) {
    entry.content = args.content;

    try {
      entry.embedding = await getEmbedding({
        text: args.content,
        projectId: await resolveMemoryStoreProjectId({
          memoryStoreId: entry.memoryStoreId,
        }),
      });
    } catch {
      // embedding is optional — continue without it
    }
  }

  if (args.tags !== undefined) {
    entry.tags = args.tags;
  }

  if (args.metadata !== undefined) {
    entry.metadata = args.metadata;
  }

  await entry.save();

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
