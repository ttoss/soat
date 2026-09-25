import type {
  MemoryAssertionMechanism,
  MemoryAssertionOutcome,
} from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';
import type { PaginatedResult } from 'src/lib/pagination';
import {
  emptyPage,
  resolvePagination,
  totalListOrder,
} from 'src/lib/pagination';

const log = createDebug('soat:memories');

/**
 * Who asserted a fact and through which door — everything about a write that is
 * not the fact itself. Supplied by each write path; `writeMemory` records
 * exactly one assertion per call, whatever the outcome.
 */
export type MemoryAssertionSource = {
  mechanism: MemoryAssertionMechanism;
  /**
   * The `memory_rules` row whose firing this is — set on every `rule` write,
   * the built-in extractor included (it is a rule with no handler). The
   * internal id, because the caller is the dispatcher holding the row; the
   * ledger's own reads answer with the rule's public id.
   */
  ruleId?: number | null;
  /** The generation's **public** id; resolved to the row here. */
  generationId?: string | null;
  principalType: string;
  principalId: string;
};

type AssertionRow = InstanceType<(typeof db)['MemoryAssertion']> & {
  memoryStore?: InstanceType<(typeof db)['MemoryStore']>;
  content?: InstanceType<(typeof db)['MemoryContent']>;
  memory?: InstanceType<(typeof db)['Memory']> | null;
  generation?: InstanceType<(typeof db)['Generation']> | null;
  rule?: InstanceType<(typeof db)['MemoryRule']> | null;
};

const assertionIncludes = () => {
  return [
    { model: db.MemoryStore, as: 'memoryStore' },
    { model: db.MemoryContent, as: 'content' },
    { model: db.Memory, as: 'memory' },
    { model: db.Generation, as: 'generation' },
    { model: db.MemoryRule, as: 'rule' },
  ];
};

/**
 * The memory each `superseded` assertion retired, as one query for the page.
 *
 * It is the reverse of `memories.superseded_by_memory_id` and is unique per
 * assertion, because the algorithm supersedes exactly the top match — one
 * memory per assertion. Kept off the assertion row on purpose: validity lives
 * on the memory, where every hot read filters it.
 */
const resolveSupersededIds = async (
  rows: AssertionRow[]
): Promise<Map<number, string>> => {
  const replacementIds = rows
    .filter((row) => {
      return row.outcome === 'superseded' && row.memoryId !== null;
    })
    .map((row) => {
      return row.memoryId as number;
    });

  if (replacementIds.length === 0) return new Map();

  const retired = await db.Memory.findAll({
    where: { supersededByMemoryId: replacementIds },
    attributes: ['publicId', 'supersededByMemoryId'],
  });

  return new Map(
    retired.map((memory) => {
      return [memory.supersededByMemoryId as number, memory.publicId];
    })
  );
};

/** A linked row's public id, or null when the link is absent. */
const linkedPublicId = (
  linked?: { publicId: string } | null
): string | null => {
  return linked?.publicId ?? null;
};

/** The memory this assertion retired, from the reverse join resolved for the page. */
const retiredMemoryId = (
  instance: AssertionRow,
  supersededIds: Map<number, string>
): string | null => {
  if (instance.memoryId === null) return null;
  return supersededIds.get(instance.memoryId) ?? null;
};

const mapAssertion = (
  instance: AssertionRow,
  supersededIds: Map<number, string>
) => {
  return {
    id: instance.publicId,
    memory_store_id: linkedPublicId(instance.memoryStore),
    memory_id: linkedPublicId(instance.memory),
    superseded_memory_id: retiredMemoryId(instance, supersededIds),
    content: instance.content?.content,
    mechanism: instance.mechanism,
    rule_id: linkedPublicId(instance.rule),
    generation_id: linkedPublicId(instance.generation),
    principal_type: instance.principalType,
    principal_id: instance.principalId,
    outcome: instance.outcome,
    similarity: instance.similarity ?? null,
    declared: instance.declared,
    created_at: instance.createdAt,
  };
};

export type MappedMemoryAssertion = ReturnType<typeof mapAssertion>;

const mapAssertions = async (
  rows: AssertionRow[]
): Promise<MappedMemoryAssertion[]> => {
  const supersededIds = await resolveSupersededIds(rows);
  return rows.map((row) => {
    return mapAssertion(row, supersededIds);
  });
};

/**
 * One page of assertions. Not `paginatedList`: the retired-memory reverse join
 * is resolved once for the whole page, and a per-row `map` would make it one
 * query per assertion.
 */
const assertionPage = async (args: {
  where: Record<string, unknown>;
  order: 'ASC' | 'DESC';
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedMemoryAssertion>> => {
  const { limit, offset } = resolvePagination(args);
  const { count, rows } = await db.MemoryAssertion.findAndCountAll({
    where: args.where,
    include: assertionIncludes(),
    order: totalListOrder([['createdAt', args.order]]),
    distinct: true,
    limit,
    offset,
  });

  return {
    data: await mapAssertions(rows as AssertionRow[]),
    total: count,
    limit,
    offset,
  };
};

const resolveGenerationDbId = async (
  generationId?: string | null
): Promise<number | null> => {
  if (!generationId) return null;
  const generation = await db.Generation.findOne({
    where: { publicId: generationId },
    attributes: ['id'],
  });
  return (generation?.id as number | undefined) ?? null;
};

/**
 * Appends one assertion. Never throws into the write it records: an audit row
 * that cannot be written must not lose the fact the caller was storing.
 */
export const recordMemoryAssertion = async (args: {
  memoryStoreId: number;
  contentId: number;
  memoryId: number | null;
  outcome: MemoryAssertionOutcome;
  similarity: number | null;
  /** Whether the caller named the memory this write replaced. */
  declared?: boolean;
  source: MemoryAssertionSource;
}): Promise<void> => {
  log(
    'recordMemoryAssertion: memoryStoreId=%d outcome=%s mechanism=%s memoryId=%o',
    args.memoryStoreId,
    args.outcome,
    args.source.mechanism,
    args.memoryId
  );

  await db.MemoryAssertion.create({
    memoryStoreId: args.memoryStoreId,
    contentId: args.contentId,
    memoryId: args.memoryId,
    generationId: await resolveGenerationDbId(args.source.generationId),
    mechanism: args.source.mechanism,
    ruleId: args.source.ruleId ?? null,
    principalType: args.source.principalType,
    principalId: args.source.principalId,
    outcome: args.outcome,
    similarity: args.similarity,
    declared: args.declared ?? false,
  });
};

/**
 * One memory's full history — every write that resolved into it, including the
 * skips it absorbed.
 *
 * A superseded memory's own assertions stay attached to it, so walking the
 * chain backwards from the replacement reaches them.
 */
export const listMemoryAssertions = async (args: {
  memoryId: number;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedMemoryAssertion>> => {
  log('listMemoryAssertions: memoryId=%d', args.memoryId);
  return assertionPage({
    where: { memoryId: args.memoryId },
    order: 'ASC',
    limit: args.limit,
    offset: args.offset,
  });
};

/**
 * The volume question as a query: which door is filling this store, and with
 * what outcomes. The ledger is the only place a skipped write leaves a row.
 */
export const listMemoryStoreAssertions = async (args: {
  memoryStoreId: number;
  mechanism?: MemoryAssertionMechanism;
  outcome?: MemoryAssertionOutcome;
  generationId?: string;
  since?: Date;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedMemoryAssertion>> => {
  log(
    'listMemoryStoreAssertions: memoryStoreId=%d mechanism=%s outcome=%s',
    args.memoryStoreId,
    args.mechanism,
    args.outcome
  );

  const where: Record<string, unknown> = { memoryStoreId: args.memoryStoreId };
  if (args.mechanism) where.mechanism = args.mechanism;
  if (args.outcome) where.outcome = args.outcome;
  if (args.since) where.createdAt = { [Op.gte]: args.since };

  if (args.generationId) {
    const generationDbId = await resolveGenerationDbId(args.generationId);
    // A filter naming a generation that does not exist selects nothing, rather
    // than silently widening to the whole store.
    if (generationDbId === null) {
      return emptyPage<MappedMemoryAssertion>(args);
    }
    where.generationId = generationDbId;
  }

  return assertionPage({
    where,
    order: 'DESC',
    limit: args.limit,
    offset: args.offset,
  });
};

/**
 * The rows behind a generation's `extraction` counts, so the summary and what
 * it summarizes can be reconciled.
 */
export const listGenerationMemoryAssertions = async (args: {
  generationDbId: number;
}): Promise<MappedMemoryAssertion[]> => {
  const rows = (await db.MemoryAssertion.findAll({
    where: { generationId: args.generationDbId },
    include: assertionIncludes(),
    order: [['createdAt', 'ASC']],
  })) as AssertionRow[];
  return mapAssertions(rows);
};
