import type {
  MemoryAssertionMechanism,
  MemoryAssertionOutcome,
} from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';
import { ownerActorWhere } from 'src/lib/actorOwnership';
import { type ActsFor, actsForColumns, servedActsFor } from 'src/lib/actsFor';
import type { Transaction } from 'src/lib/dbTransaction';
import {
  emptyPage,
  type ListFilters,
  type Page,
  paginatedList,
} from 'src/lib/pagination';
import type { ActingPrincipalType } from 'src/lib/principals';
import { timeRangeWhere } from 'src/lib/timeRange';

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
  principalType: ActingPrincipalType | 'agent';
  principalId: string;
  /** Whom the asserter acted for: its request's or its turn's. */
  actsFor: ActsFor | null;
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
    acts_for: servedActsFor({
      type: instance.actsForType,
      id: instance.actsForId,
    }),
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
 * One page of assertions. The retired-memory reverse join is resolved once for
 * the whole page after paging, since a per-row `map` would make it one query
 * per assertion.
 */
const assertionPage = async (args: {
  where: Record<string, unknown>;
  filters: ListFilters;
  direction: 'ASC' | 'DESC';
  limit?: number;
  cursor?: string;
}): Promise<Page<MappedMemoryAssertion>> => {
  const page = await paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: args.filters,
    where: args.where,
    order: [['createdAt', args.direction]],
    query: ({ where, limit, order }) => {
      return db.MemoryAssertion.findAll({
        where,
        include: assertionIncludes(),
        order,
        limit,
      });
    },
    map: (row) => {
      return row as AssertionRow;
    },
  });

  return { ...page, data: await mapAssertions(page.data) };
};

const resolveGenerationDbId = async (args: {
  generationId?: string | null;
  transaction?: Transaction;
}): Promise<number | null> => {
  if (!args.generationId) return null;
  const generation = await db.Generation.findOne({
    where: { publicId: args.generationId },
    attributes: ['id'],
    transaction: args.transaction,
  });
  return (generation?.id as number | undefined) ?? null;
};

/**
 * Strictly after the memory's previous assertion. A memory's history is read
 * in `createdAt` order, and two writes can share a millisecond or come from
 * processes whose clocks disagree; either would show an effect before its cause.
 */
const nextAssertionTime = async (args: {
  memoryId: number;
  transaction: Transaction;
}): Promise<Date> => {
  const now = new Date();
  const previous = await db.MemoryAssertion.findOne({
    where: { memoryId: args.memoryId },
    attributes: ['createdAt'],
    order: [['createdAt', 'DESC']],
    transaction: args.transaction,
  });
  if (!previous || previous.createdAt < now) return now;
  return new Date(previous.createdAt.getTime() + 1);
};

/** What a write states about itself; the memory it lands on comes from the write. */
export type MemoryAssertionRecord = {
  memoryStoreId: number;
  contentId: number;
  outcome: MemoryAssertionOutcome;
  similarity: number | null;
  /** Whether the caller named the memory this write replaced. */
  declared?: boolean;
  source: MemoryAssertionSource;
};

/**
 * The one way a memory changes: `write` and the assertion recording it commit
 * in one transaction, so no reader sees a memory row's change without its
 * assertion, and a failed assertion rolls the change back.
 */
export const writeAssertedMemory = async <
  T extends InstanceType<(typeof db)['Memory']>,
>(args: {
  write: (options: { transaction: Transaction }) => Promise<T>;
  assertion: MemoryAssertionRecord;
}): Promise<T> => {
  const { assertion } = args;
  log(
    'writeAssertedMemory: memoryStoreId=%d outcome=%s mechanism=%s',
    assertion.memoryStoreId,
    assertion.outcome,
    assertion.source.mechanism
  );

  return db.sequelize.transaction(async (transaction) => {
    const memory = await args.write({ transaction });
    const memoryId = memory.id as number;
    await db.MemoryAssertion.create(
      {
        memoryStoreId: assertion.memoryStoreId,
        contentId: assertion.contentId,
        memoryId,
        generationId: await resolveGenerationDbId({
          generationId: assertion.source.generationId,
          transaction,
        }),
        mechanism: assertion.source.mechanism,
        ruleId: assertion.source.ruleId ?? null,
        principalType: assertion.source.principalType,
        principalId: assertion.source.principalId,
        ...actsForColumns(assertion.source.actsFor),
        outcome: assertion.outcome,
        similarity: assertion.similarity,
        declared: assertion.declared ?? false,
        createdAt: await nextAssertionTime({ memoryId, transaction }),
      },
      { transaction }
    );
    return memory;
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
  cursor?: string;
}): Promise<Page<MappedMemoryAssertion>> => {
  log('listMemoryAssertions: memoryId=%d', args.memoryId);
  return assertionPage({
    where: { memoryId: args.memoryId },
    filters: { memoryId: args.memoryId },
    direction: 'ASC',
    limit: args.limit,
    cursor: args.cursor,
  });
};

/**
 * The volume question as a query: which door is filling this store, and with
 * what outcomes. The ledger is the only place a skipped write leaves a row.
 */
export const listMemoryStoreAssertions = async (args: {
  memoryStoreId: number;
  /** Only the writes that resolved into this actor's memories. */
  actorId?: string;
  mechanism?: MemoryAssertionMechanism;
  outcome?: MemoryAssertionOutcome;
  generationId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}): Promise<Page<MappedMemoryAssertion>> => {
  log(
    'listMemoryStoreAssertions: memoryStoreId=%d mechanism=%s outcome=%s',
    args.memoryStoreId,
    args.mechanism,
    args.outcome
  );

  const where: Record<string, unknown> = { memoryStoreId: args.memoryStoreId };
  if (args.mechanism) where.mechanism = args.mechanism;
  if (args.outcome) where.outcome = args.outcome;
  const owner = await ownerActorWhere({ actorId: args.actorId });
  if (owner.actorId !== undefined) {
    // Integer from the actor row, never caller text.
    where.memoryId = {
      [Op.in]: db.sequelize.literal(
        `(SELECT id FROM memories WHERE actor_id = ${owner.actorId})`
      ),
    };
  }
  const createdAt = timeRangeWhere({ from: args.from, to: args.to });
  if (createdAt) where.createdAt = createdAt;

  if (args.generationId) {
    const generationDbId = await resolveGenerationDbId({
      generationId: args.generationId,
    });
    // A filter naming a generation that does not exist selects nothing, rather
    // than silently widening to the whole store.
    if (generationDbId === null) {
      return emptyPage<MappedMemoryAssertion>(args);
    }
    where.generationId = generationDbId;
  }

  return assertionPage({
    where,
    filters: {
      memoryStoreId: args.memoryStoreId,
      actorId: args.actorId,
      mechanism: args.mechanism,
      outcome: args.outcome,
      generationId: args.generationId,
      from: args.from,
      to: args.to,
    },
    direction: 'DESC',
    limit: args.limit,
    cursor: args.cursor,
  });
};

/**
 * The rows behind a generation's `extraction` counts, so the summary and what
 * it summarizes can be reconciled.
 */
export const listGenerationMemoryAssertions = async (args: {
  generationDbId: number;
  limit?: number;
  cursor?: string;
}): Promise<Page<MappedMemoryAssertion>> => {
  log('listGenerationMemoryAssertions: generation=%d', args.generationDbId);
  return assertionPage({
    where: { generationId: args.generationDbId },
    filters: { generationDbId: args.generationDbId },
    direction: 'ASC',
    limit: args.limit,
    cursor: args.cursor,
  });
};
