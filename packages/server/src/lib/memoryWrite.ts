import type { MemorySource } from '@soat/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import type { MemoryAssertionSource } from 'src/lib/memoryAssertions';
import { recordMemoryAssertion } from 'src/lib/memoryAssertions';
import { resolveMemoryContent } from 'src/lib/memoryContents';
import type { MappedMemory, MemoryRow } from 'src/lib/memoryMapper';
import { mapMemory, memories, memoryIncludes } from 'src/lib/memoryMapper';
import { validMemoryWhere } from 'src/lib/memoryValidity';
import { mergeTags } from 'src/lib/tags';
import { withIterativeVectorScan } from 'src/lib/vectorSearch';

const log = createDebug('soat:memories');

/**
 * The algorithm's own thresholds, used when neither the request nor the store
 * sets one.
 *
 * The supersede floor is `0.90` and not the `0.75` the retired merge band used:
 * between them cosine covers both "same fact, changed" and "related but
 * distinct" ("prefers email" vs "prefers Portuguese"), and embeddings sit close
 * on negations too. A model arbitrated that band; superseding blind there would
 * silently delete true facts. At `0.90` "same fact" dominates strongly enough
 * to act without a judge, and below it `created` is the safe error — a
 * near-duplicate stays searchable, where a wrongly retired fact would not.
 */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.95;
export const DEFAULT_SUPERSEDE_THRESHOLD = 0.9;

export type MemoryWriteAction = 'created' | 'superseded' | 'skipped';

export type MemoryWriteResult = {
  action: MemoryWriteAction;
  entry: MappedMemory;
};

/** The outcome a write resolved to, and the memory it resolved into. */
type SettledWrite = { action: MemoryWriteAction; memory: MemoryRow };

export type EffectiveThresholds = {
  duplicateThreshold: number;
  supersedeThreshold: number;
};

type MemoryStoreWriteContext = EffectiveThresholds & {
  projectId: number | null;
};

/**
 * The effective pair for a write: request value, else store default, else the
 * algorithm constant, resolved per value.
 *
 * Exported because the request must be validated against the *effective* pair,
 * not against itself — a request overriding only one of the two could otherwise
 * invert it against the store's other value.
 */
export const resolveMemoryThresholds = (args: {
  store?: {
    duplicateThreshold: number | null;
    supersedeThreshold: number | null;
  } | null;
  duplicateThreshold?: number;
  supersedeThreshold?: number;
}): EffectiveThresholds => {
  return {
    duplicateThreshold:
      args.duplicateThreshold ??
      args.store?.duplicateThreshold ??
      DEFAULT_DUPLICATE_THRESHOLD,
    supersedeThreshold:
      args.supersedeThreshold ??
      args.store?.supersedeThreshold ??
      DEFAULT_SUPERSEDE_THRESHOLD,
  };
};

/**
 * `null` when the pair is usable, otherwise why it is not. Equal makes
 * `superseded` unreachable; inverted swallows `skipped` — either way one of the
 * three outcomes silently stops occurring, which is exactly the kind of quiet
 * behavior change this module exists to make visible.
 */
export const findThresholdOrderError = (
  thresholds: EffectiveThresholds
): string | null => {
  if (thresholds.supersedeThreshold < thresholds.duplicateThreshold) {
    return null;
  }
  return 'supersede_threshold must be lower than duplicate_threshold';
};

/**
 * The store's project (what an embedding is billed to) and its threshold
 * defaults, in one read. A memory is addressed by its store, never by a
 * project, so the owner is read here rather than threaded through every write
 * path that reaches this function.
 */
const loadStoreWriteContext = async (args: {
  memoryStoreId: number;
  duplicateThreshold?: number;
  supersedeThreshold?: number;
}): Promise<MemoryStoreWriteContext> => {
  const store = await db.MemoryStore.findByPk(args.memoryStoreId, {
    attributes: ['projectId', 'duplicateThreshold', 'supersedeThreshold'],
  });

  return {
    projectId: store?.projectId ?? null,
    ...resolveMemoryThresholds({
      store,
      duplicateThreshold: args.duplicateThreshold,
      supersedeThreshold: args.supersedeThreshold,
    }),
  };
};

/**
 * The store's most similar **currently valid** memory, by cosine over the
 * shared content row's vector.
 *
 * The join is what keeps the two halves where they belong: the vector lives on
 * `memory_contents` (where the HNSW index is), and `invalidated_at` stays on
 * the memory, so the validity filter still decides candidacy. A retired fact is
 * never a candidate — a write restating superseded knowledge must land as a new
 * memory, not resurrect the row that was invalidated precisely because it no
 * longer holds.
 */
const findTopSimilarMemory = async (args: {
  memoryStoreId: number;
  embeddingLiteral: string;
}): Promise<MemoryRow | null> => {
  // The includes join memories to themselves (`supersededByMemory`), so the
  // vector is qualified with the content join's alias: a bare `embedding` would
  // be ambiguous.
  const distance = `"content"."embedding" <=> '${args.embeddingLiteral}'`;

  // Every filter here is applied *after* the HNSW index proposes candidates, so
  // without an iterative scan a crowded index can hide this store's own match
  // and the write falls through to create a near-duplicate.
  const match = await withIterativeVectorScan({
    run: ({ transaction }) => {
      return db.Memory.findOne({
        where: {
          memoryStoreId: args.memoryStoreId,
          ...validMemoryWhere(),
        },
        attributes: {
          include: [[db.Memory.sequelize!.literal(distance), 'distance']],
        },
        include: memoryIncludes(),
        // A memory whose content has no vector yields a null distance, which
        // Postgres orders last — so an unembedded row can never displace a real
        // match, and a store with no vectors at all scores 0 and creates.
        order: db.Memory.sequelize!.literal(distance),
        subQuery: false,
        transaction,
      });
    },
  });

  return match as MemoryRow | null;
};

/**
 * The memory a write names as the one it replaces, checked against the store it
 * is being written into.
 *
 * A declaration is not a similarity question, so none of these refusals can be
 * softened into an outcome: a write that named the wrong memory must fail
 * loudly rather than land as a `created` the caller never asked for.
 *
 * Same store only: a store is an ownership and scope boundary, and a
 * declaration reaching across one would retire a fact under a policy this write
 * was never checked against. No chaining either: a retired memory already
 * points at its replacement, and superseding it again forks the chain the
 * ledger reads back along.
 */
const resolveDeclaredTarget = async (args: {
  memoryStoreId: number;
  supersedes: string;
}): Promise<MemoryRow> => {
  const target = (await db.Memory.findOne({
    where: { publicId: args.supersedes },
    include: memoryIncludes(),
  })) as MemoryRow | null;

  if (!target) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory not found');
  }
  if (target.memoryStoreId !== args.memoryStoreId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'supersedes must name a memory in the same memory store'
    );
  }
  if (target.invalidatedAt !== null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'supersedes must name a memory that is still valid'
    );
  }

  return target;
};

/**
 * The cosine between the incoming content and the declared target.
 *
 * It decides nothing — the declaration already did — but it is the measurement
 * the ledger exists to be sampled for: how far apart the two statements of a
 * fact were when a caller had to say so, which is the number that would justify
 * arbitrating this band by model later.
 */
const similarityToMemory = async (args: {
  target: MemoryRow;
  embeddingLiteral: string | null;
}): Promise<number | null> => {
  if (!args.embeddingLiteral) return null;

  const distance = `"embedding" <=> '${args.embeddingLiteral}'`;
  const row = await db.MemoryContent.findOne({
    where: { id: args.target.contentId },
    attributes: [[db.MemoryContent.sequelize!.literal(distance), 'distance']],
  });
  const value = row?.getDataValue('distance') as string | null | undefined;

  return value == null ? null : 1 - parseFloat(value);
};

const similarityOf = (match: MemoryRow): number => {
  const distance = parseFloat(
    (match.getDataValue('distance') as string | null) ?? '1'
  );
  return 1 - distance;
};

/**
 * Tags and metadata for the memory replacing a superseded one: the retired
 * memory's bags, with the incoming keys winning.
 *
 * Carried forward rather than dropped because a supersede states the *same
 * fact, changed* — a replacement that lost the original's `role` tag would
 * silently fall out of every tag-scoped search and policy the original
 * satisfied, which is precisely the invisible loss this design removes
 * elsewhere.
 */
const inheritBags = (args: {
  retired: MemoryRow;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
}) => {
  return {
    tags:
      args.tags && Object.keys(args.tags).length > 0
        ? mergeTags({
            current: args.retired.tags,
            incoming: args.tags,
            merge: true,
          })
        : args.retired.tags,
    metadata:
      args.metadata || args.retired.metadata
        ? { ...(args.retired.metadata ?? {}), ...(args.metadata ?? {}) }
        : null,
  };
};

const createMemoryRow = async (args: {
  memoryStoreId: number;
  contentId: number;
  sourceType?: MemorySource;
  sourceConversationPublicId?: string | null;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
}) => {
  const conversationPublicId = args.sourceConversationPublicId ?? null;
  return db.Memory.create({
    memoryStoreId: args.memoryStoreId,
    contentId: args.contentId,
    sourceType: conversationPublicId
      ? 'conversation'
      : (args.sourceType ?? 'manual'),
    sourceId: conversationPublicId,
    tags: args.tags ?? null,
    metadata: args.metadata ?? null,
  });
};

/**
 * Retires the matched memory and creates its replacement.
 *
 * Lossless at the audit level: the old memory stays readable by id (with
 * `include_invalidated`), its text intact on the content row it still points
 * at, and its own assertions attached. What changes is retrieval — only the
 * newest statement of a fact is searchable, which is what temporal invalidation
 * was always for.
 */
const supersedeMemory = async (args: {
  match: MemoryRow;
  memoryStoreId: number;
  contentId: number;
  sourceType?: MemorySource;
  sourceConversationPublicId?: string | null;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
}) => {
  const replacement = await createMemoryRow({
    memoryStoreId: args.memoryStoreId,
    contentId: args.contentId,
    sourceType: args.sourceType,
    sourceConversationPublicId: args.sourceConversationPublicId,
    ...inheritBags({
      retired: args.match,
      tags: args.tags,
      metadata: args.metadata,
    }),
  });

  args.match.invalidatedAt = new Date();
  args.match.supersededByMemoryId = replacement.id as number;
  await args.match.save();

  return replacement;
};

export type WriteMemoryArgs = {
  memoryStoreId: number;
  content: string;
  sourceType?: MemorySource;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
  /**
   * Per-call overrides. Only the `api` door passes them: a rule or an agent
   * must not be able to loosen the corpus's dedup policy from the side, which
   * would make the store-level default meaningless.
   */
  duplicateThreshold?: number;
  supersedeThreshold?: number;
  /**
   * The conversation this fact was learned in, as a public id. Supplied by the
   * extraction path when a turn belongs to a conversation; absent everywhere
   * else, which is what makes those writes `manual`.
   *
   * Recorded on creation only. Superseding writes a *new* memory carrying its
   * own provenance, so nothing is ever rewritten.
   */
  sourceConversationPublicId?: string;
  /**
   * The public id of the memory this write replaces, named by the caller.
   *
   * It outranks the bands in both directions: a declaration is not a similarity
   * question, so it must not become a `skipped` because the two texts are
   * near-identical, nor a `created` because they are far apart — which is the
   * case it exists for ("The office is in Lisbon" -> "We closed the Lisbon
   * office" never reaches `supersede_threshold`).
   *
   * Authorization on the *target* is the caller's door to enforce: the REST
   * route requires `memories:UpdateMemory` on it, so a declaration says no more
   * and does no more than updating that memory directly would.
   */
  supersedes?: string;
  /** Who is asserting, and through which door. */
  assertion: MemoryAssertionSource;
};

/**
 * What the outcome is measured against: the band's top match, or the distance
 * to a declared target.
 *
 * A declaration has already chosen its memory, so the top-match search is not
 * run at all — there is no band left to apply it to, and nothing else in the
 * store can be touched by the write.
 */
const measureWrite = async (args: {
  memoryStoreId: number;
  embeddingLiteral: string | null;
  declaredTarget: MemoryRow | null;
}): Promise<{ match: MemoryRow | null; similarity: number | null }> => {
  if (args.declaredTarget) {
    return {
      match: null,
      similarity: await similarityToMemory({
        target: args.declaredTarget,
        embeddingLiteral: args.embeddingLiteral,
      }),
    };
  }

  if (!args.embeddingLiteral) {
    return { match: null, similarity: null };
  }

  const match = await findTopSimilarMemory({
    memoryStoreId: args.memoryStoreId,
    embeddingLiteral: args.embeddingLiteral,
  });

  return { match, similarity: match ? similarityOf(match) : null };
};

/**
 * The one exit every outcome takes: append the assertion, then reload the
 * memory through the same includes, so no branch can return a result the others
 * would not, or leave the write unrecorded.
 */
const settleWrite = async (
  args: SettledWrite & {
    memoryStoreId: number;
    contentId: number;
    similarity: number | null;
    declared: boolean;
    assertion: MemoryAssertionSource;
  }
): Promise<MemoryWriteResult> => {
  await recordMemoryAssertion({
    memoryStoreId: args.memoryStoreId,
    contentId: args.contentId,
    memoryId: args.memory.id as number,
    outcome: args.action,
    similarity: args.similarity,
    declared: args.declared,
    source: args.assertion,
  });

  return {
    action: args.action,
    entry: mapMemory(await memories.reload(args.memory)),
  };
};

/**
 * The one write funnel: embed (or hit the content hash), find the top valid
 * match, and resolve to exactly one of three outcomes.
 *
 *   supersedes named                   -> superseded  the caller says which
 *   similarity >= duplicate_threshold  -> skipped     same fact, already known
 *   similarity >= supersede_threshold  -> superseded  same fact, changed
 *   otherwise                          -> created     distinct fact
 *
 * No model call. The merge this replaced was non-deterministic, drifted the
 * merged embedding away from both inputs, destroyed the original text of both
 * facts, and was the only LLM call *inside* a write — on the in-turn tool path.
 *
 * Every call appends exactly one assertion, including the skips, which is the
 * half no column on the memory row could record.
 */
export const writeMemory = async (
  args: WriteMemoryArgs
): Promise<MemoryWriteResult> => {
  const store = await loadStoreWriteContext(args);

  // Before the embedder: a write naming a target it may not have is refused
  // without spending an embedding on content that is not going to be stored.
  const declaredTarget = args.supersedes
    ? await resolveDeclaredTarget({
        memoryStoreId: args.memoryStoreId,
        supersedes: args.supersedes,
      })
    : null;

  log(
    'writeMemory: memoryStoreId=%d mechanism=%s duplicate=%d supersede=%d declared=%s',
    args.memoryStoreId,
    args.assertion.mechanism,
    store.duplicateThreshold,
    store.supersedeThreshold,
    declaredTarget?.publicId
  );

  const content = await resolveMemoryContent({
    memoryStoreId: args.memoryStoreId,
    content: args.content,
    projectId: store.projectId,
    generationId: args.assertion.generationId,
  });

  const { match, similarity } = await measureWrite({
    memoryStoreId: args.memoryStoreId,
    embeddingLiteral: content.embedding
      ? `[${content.embedding.join(',')}]`
      : null,
    declaredTarget,
  });

  log(
    'writeMemory: contentId=%d matched=%s similarity=%o',
    content.id,
    match?.publicId,
    similarity
  );

  // Every outcome writes its memory from the same content row and provenance,
  // whether that row is new or the replacement for a retired one.
  const rowArgs = {
    memoryStoreId: args.memoryStoreId,
    contentId: content.id as number,
    sourceType: args.sourceType,
    sourceConversationPublicId: args.sourceConversationPublicId,
    tags: args.tags,
    metadata: args.metadata,
  };

  const settle = (settled: SettledWrite) => {
    return settleWrite({
      ...settled,
      memoryStoreId: args.memoryStoreId,
      contentId: content.id as number,
      similarity,
      declared: declaredTarget !== null,
      assertion: args.assertion,
    });
  };

  const replacementFor = (retired: MemoryRow) => {
    return supersedeMemory({ match: retired, ...rowArgs });
  };

  if (declaredTarget) {
    return settle({
      action: 'superseded',
      memory: await replacementFor(declaredTarget),
    });
  }

  if (match && similarity !== null) {
    if (similarity >= store.duplicateThreshold) {
      return settle({ action: 'skipped', memory: match });
    }
    if (similarity >= store.supersedeThreshold) {
      return settle({
        action: 'superseded',
        memory: await replacementFor(match),
      });
    }
  }

  return settle({
    action: 'created',
    memory: await createMemoryRow(rowArgs),
  });
};
