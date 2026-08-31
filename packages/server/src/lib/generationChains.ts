/**
 * The continuation chain as a first-class, readable record.
 *
 * A chain is the population of generations descending from one root through
 * `initiator_generation_id` declarations. Before this it existed only as a value
 * repeated on its members (`generations.root_generation_id`), so "how big is
 * this chain, is it still alive, and why did it stop?" could only be answered by
 * a `COUNT` plus inference from stop reasons — which is why #1161 ran for 17
 * days before anyone named the runaway as one thing.
 *
 * Two rules hold everything else together:
 *
 * - **Status is observability, not a gate.** Enforcement still counts member
 *   rows by `root_generation_id` (`generationChain.ts`), never this row. A chain
 *   row that is missing, stale or wrong therefore cannot let a runaway through.
 * - **Every producer write is best-effort.** These functions are called from the
 *   generation path; a failure here is logged and swallowed, because failing a
 *   generation to record a chain status would trade the thing that matters for
 *   the thing that describes it.
 */
import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { paginatedList, type PaginatedResult } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';

const log = createDebug('soat:generation');

export const CHAIN_STATUSES = [
  'active',
  'concluded',
  'expired',
  'budget_exhausted',
] as const;

export type ChainStatus = (typeof CHAIN_STATUSES)[number];

type ChainInstance = InstanceType<(typeof db)['GenerationChain']> & {
  project?: InstanceType<(typeof db)['Project']> | null;
};

const buildIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

const chains = makeResourceAccessor<ChainInstance>({
  model: () => {
    return db.GenerationChain;
  },
  includes: buildIncludes,
  label: 'Chain',
  errorCode: 'CHAIN_NOT_FOUND',
});

/**
 * Row → wire. `rootGenerationId` is deliberately **absent**: it is the chain's
 * internal key, and exposing it would make a second, competing handle for the
 * same thing. A caller walks chain → members with
 * `GET /api/v1/generations?chain_id=<id>`, which is why `generation_count`
 * matches what that filter returns.
 */
export const mapChain = (instance: ChainInstance) => {
  return {
    id: instance.publicId,
    project_id: instance.project?.publicId,
    agent_id: instance.agentId,
    status: instance.status,
    generation_count: instance.generationCount,
    last_generation_at: instance.lastGenerationAt,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

export type MappedChain = ReturnType<typeof mapChain>;

export const listChains = async (args: {
  projectIds: number[];
  status?: string;
  agentId?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedChain>> => {
  const where: Record<string, unknown> = { projectId: args.projectIds };
  if (args.status) where.status = args.status;
  // A plain public-id string, not an FK: an unknown value matches no row, which
  // is the same answer as an agent with no chains.
  if (args.agentId) where.agentId = args.agentId;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.GenerationChain.findAndCountAll({
        where,
        include: buildIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapChain,
  });
};

export const getChain = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedChain> => {
  return mapChain(await chains.getByPublicId(args));
};

// ── Producer side ─────────────────────────────────────────────────────────

const findByRoot = async (
  rootGenerationId: string
): Promise<ChainInstance | null> => {
  return db.GenerationChain.findOne({ where: { rootGenerationId } });
};

/**
 * The chain a continuation belongs to, created on first use.
 *
 * Lazy because a root that never continues is not a chain: creating a row per
 * generation would bury the runaways this table exists to surface. `memberCount`
 * seeds `generationCount` so a chain whose root predates this table still reads
 * a true size from its first hop onwards.
 *
 * The unique index on `root_generation_id` — not this read-before-write — is
 * what keeps it single: two hops on the same root can race here, and the loser
 * re-reads the winner's row.
 */
export const findOrCreateChain = async (args: {
  projectId: number;
  agentId: string | null;
  rootGenerationId: string;
  memberCount: number;
}): Promise<string | null> => {
  try {
    const existing = await findByRoot(args.rootGenerationId);
    if (existing) return existing.publicId;

    const publicId = generatePublicId(PUBLIC_ID_PREFIXES.generationChain);
    try {
      await db.GenerationChain.create({
        publicId,
        projectId: args.projectId,
        agentId: args.agentId,
        rootGenerationId: args.rootGenerationId,
        status: 'active',
        generationCount: args.memberCount,
      });
    } catch {
      // A concurrent hop won the unique index; its row is the chain.
      const winner = await findByRoot(args.rootGenerationId);
      return winner?.publicId ?? null;
    }

    // The root is a member of the chain but is created before the chain exists,
    // so it is the one row that has to be told afterwards — otherwise
    // `generation_count` and the `chain_id` filter disagree by exactly one.
    await db.Generation.update(
      { chainId: publicId },
      { where: { publicId: args.rootGenerationId } }
    );

    log(
      'findOrCreateChain: created chain=%s root=%s members=%d',
      publicId,
      args.rootGenerationId,
      args.memberCount
    );
    return publicId;
  } catch (error) {
    log('findOrCreateChain: failed root=%s %o', args.rootGenerationId, error);
    return null;
  }
};

/**
 * The chain a continuation's `chain_id` column names. Deliberately **not**
 * best-effort like the writes below: this one feeds a column on the generation
 * being created, and swallowing a read failure would store `chain_id: null` on a
 * real chain member — a silently mis-linked row rather than a loud failure on a
 * path whose caller already handles one.
 */
export const findChainIdByRoot = async (
  rootGenerationId: string
): Promise<string | null> => {
  const chain = await findByRoot(rootGenerationId);
  return chain?.publicId ?? null;
};

/**
 * The best-effort contract, in one place: load the chain, apply an update, and
 * let nothing escape.
 *
 * Every producer below shares it because every one of them is called from the
 * generation path, where a thrown observability write would fail the thing it
 * exists to describe. Written once rather than four times so "swallow and log"
 * cannot drift into "swallow silently" in the copy nobody re-reads.
 *
 * A missing row is a no-op: the chain is created before any of these run, so it
 * only means the row was removed underneath us (a project delete mid-flight).
 */
const withChain = async (
  rootGenerationId: string,
  apply: (chain: ChainInstance) => Promise<void>
): Promise<void> => {
  try {
    const chain = await findByRoot(rootGenerationId);
    if (!chain) return;
    await apply(chain);
  } catch (error) {
    /* istanbul ignore next -- only a broken DB write reaches here, and faking
       one would mean mocking the database this suite deliberately runs for
       real (`.claude/rules/tests.md`). */
    log('withChain: failed root=%s %o', rootGenerationId, error);
  }
};

/**
 * Records that the chain just gained a generation.
 *
 * The count is **re-derived** from the members rather than incremented, so a
 * write this table loses cannot leave the number permanently wrong — the next
 * hop heals it. `active` is set unconditionally: a chain that is spawning is
 * alive again whatever it read before.
 */
export const recordChainGrowth = async (args: {
  rootGenerationId: string;
}): Promise<void> => {
  return withChain(args.rootGenerationId, async (chain) => {
    // Members are the continuations carrying the root's id, plus the root.
    const continuations = await db.Generation.count({
      where: { rootGenerationId: args.rootGenerationId },
    });

    await chain.update({
      status: 'active',
      generationCount: continuations + 1,
      lastGenerationAt: new Date(),
    });
  });
};

/**
 * Moves the chain to a terminal-looking status. Unconditional, because a
 * refusal and a terminal expiry are both statements about the chain that
 * outrank whatever a member's completion concluded — and a later hop, if one
 * ever comes, sets `active` again through {@link recordChainGrowth}.
 */
export const markChainStatus = async (args: {
  rootGenerationId: string;
  status: Exclude<ChainStatus, 'active' | 'concluded'>;
}): Promise<void> => {
  return withChain(args.rootGenerationId, async (chain) => {
    await chain.update({ status: args.status });
    log('markChainStatus: chain=%s status=%s', chain.publicId, args.status);
  });
};

/**
 * Whether any approval is still holding this chain open. A pending tool-call
 * approval is precisely what a later hop is spawned from, so a chain with one is
 * not finished no matter what its members' statuses say.
 */
const hasPendingApprovals = async (
  rootGenerationId: string
): Promise<boolean> => {
  const members = await db.Generation.findAll({
    where: { rootGenerationId },
    attributes: ['publicId'],
  });
  const memberIds = [
    rootGenerationId,
    ...members.map((member) => {
      return member.publicId;
    }),
  ];
  const pending = await db.ApprovalItem.count({
    where: { status: 'pending', generationId: memberIds },
  });
  return pending > 0;
};

/**
 * Marks the chain quiescent once a member has settled and nothing is left to
 * resume it.
 *
 * `concluded` is *not* terminal: an approval resolved months later spawns
 * another hop and {@link recordChainGrowth} puts the chain back to `active`. It
 * answers the operator's actual question — "which chains might still be
 * spending?" — for which a status that could only ever be set once would be
 * useless.
 *
 * Only applied from `active`, so it can never overwrite a `budget_exhausted` or
 * `expired` chain whichever order the two writes happen to land in.
 */
export const concludeChainIfSettled = async (args: {
  rootGenerationId: string;
}): Promise<void> => {
  return withChain(args.rootGenerationId, async (chain) => {
    if (chain.status !== 'active') return;
    if (await hasPendingApprovals(args.rootGenerationId)) return;

    await chain.update({ status: 'concluded' });
    log('concludeChainIfSettled: chain=%s concluded', chain.publicId);
  });
};

/**
 * The chain ended because a held approval lapsed and the agent does not react to
 * expiry. Distinguished from `concluded` because nothing chose to stop here —
 * the deadline did, which is a different thing to triage.
 *
 * Never applied over `budget_exhausted`. Both are endings, but only one of them
 * names a misconfiguration, and an over-budget chain's last held calls lapse as
 * a matter of course — relabelling it `expired` would quietly retire the signal
 * that someone still has a number to fix.
 */
export const expireChainIfSettled = async (args: {
  rootGenerationId: string;
}): Promise<void> => {
  return withChain(args.rootGenerationId, async (chain) => {
    if (chain.status === 'budget_exhausted') return;
    if (await hasPendingApprovals(args.rootGenerationId)) return;

    await chain.update({ status: 'expired' });
    log('expireChainIfSettled: chain=%s expired', chain.publicId);
  });
};

/**
 * A generation that will not run again. `failed` counts: a chain whose last
 * member died and holds no pending approval cannot spawn another hop, and
 * leaving it `active` would report a dead chain as a live one. The failure
 * itself is read off the generation, not off the chain.
 */
const TERMINAL_GENERATION_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
]);

/**
 * Called from `updateGenerationRecord` — the one funnel every completion path
 * goes through — whenever a generation's status changes. Fire-and-forget: an
 * observability write must not be able to fail the generation it describes.
 */
export const noteChainMemberSettled = (args: {
  rootGenerationId: string | null;
  status: string;
}): void => {
  const { rootGenerationId } = args;
  if (!rootGenerationId) return;
  if (!TERMINAL_GENERATION_STATUSES.has(args.status)) return;
  void concludeChainIfSettled({ rootGenerationId });
};
