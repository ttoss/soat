import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  buildChainGuardResult,
  resolveAgentForGeneration,
} from './agentGenerationRecovery';
import { type GenerationResult } from './agentGenerationTypes';

const log = createDebug('soat:generation');

/**
 * How many continuations one chain may spawn before the platform stops
 * resuming it.
 *
 * A continuation chain is unbounded by construction: each hop is a fresh turn
 * with a fresh step budget, so `max_call_depth` — which bounds recursion
 * *within* a request — never sees it. An agent that cannot terminate on its own
 * therefore compounds one round per approval TTL until someone notices, which
 * took 17 days and ~US$424 the first time (#1161).
 *
 * The budget counts generations, not hops, because the runaway fans out: a turn
 * holding N gated calls seeds N continuations, so a depth limit of D still
 * permits N^D turns. Counting the population bounds the tree.
 */
const DEFAULT_MAX_CONTINUATION_CHAIN_GENERATIONS = 100;

export const maxContinuationChainGenerations = (): number => {
  const configured = Number(process.env.MAX_CONTINUATION_CHAIN_GENERATIONS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_CONTINUATION_CHAIN_GENERATIONS;
};

export type ChainContext = {
  /** The initiator's own trace — this hop's parent. */
  parentTraceId: string;
  /** The trace the whole chain is rooted at; the initiator's own when it is the root. */
  rootTraceId: string;
  /** Continuations already in this chain, the initiator's own hop included. */
  chainSize: number;
};

/**
 * Every trace in one chain: the root plus everything that named it as root.
 * Same shape as `getTraceTree`'s tree query, narrowed to ids.
 */
const chainTraceIds = async (rootTraceDbId: number): Promise<number[]> => {
  const traces = await db.Trace.findAll({
    where: { [Op.or]: [{ id: rootTraceDbId }, { rootTraceId: rootTraceDbId }] },
    attributes: ['id'],
  });
  return traces.map((trace) => {
    return trace.id as number;
  });
};

/**
 * Resolves the chain a continuation belongs to from the generation it declares
 * as its initiator: the lineage the new turn inherits, and how large the chain
 * already is.
 *
 * The lineage is **derived here rather than passed in** so that declaring a
 * parent is the only thing a continuation has to get right — the three paths
 * that seed one had each dropped the trace ids, and a chain whose every hop is
 * an unlinked root is invisible to the guard, to the trace tree, and to anyone
 * reading the incident afterwards.
 *
 * Returns `null` when the initiator (or its trace) cannot be resolved: a
 * continuation whose parent is gone is treated as a root rather than refused,
 * which is the same fail-open stance `resolveContinuationAuthHeader` takes for
 * the same reason — the row it names is a stored id, not a foreign key.
 */
export const resolveChainContext = async (args: {
  initiatorGenerationId: string;
}): Promise<ChainContext | null> => {
  const initiator = await db.Generation.findOne({
    where: { publicId: args.initiatorGenerationId },
    include: [
      {
        model: db.Trace,
        as: 'trace',
        include: [{ model: db.Trace, as: 'rootTrace' }],
      },
    ],
  });

  const trace = initiator?.trace;
  if (!trace) {
    log(
      'resolveChainContext: initiator %s has no trace, treating as root',
      args.initiatorGenerationId
    );
    return null;
  }

  const rootTrace = trace.rootTrace ?? trace;
  const traceIds = await chainTraceIds(rootTrace.id as number);

  // Only hops that declared an initiator count. A nested agent-to-agent call
  // shares the root trace but is bounded by `max_call_depth` already, and
  // charging it to this budget would refuse a legitimate fan-out.
  const chainSize = await db.Generation.count({
    where: {
      traceId: traceIds,
      initiatorGenerationId: { [Op.ne]: null },
    },
  });

  return {
    parentTraceId: trace.publicId as string,
    rootTraceId: rootTrace.publicId as string,
    chainSize,
  };
};

/** The lineage a hop inherits: both null when it is not a continuation. */
export type ChainLineage = {
  parentTraceId: string | null;
  rootTraceId: string | null;
};

const NO_LINEAGE: ChainLineage = { parentTraceId: null, rootTraceId: null };

/**
 * The trace lineage a continuation inherits from the generation it declares as
 * its initiator, for the paths that seed a suspended generation directly rather
 * than through {@link resolveChainOrRefuse}.
 */
export const resolveChainLineage = async (args: {
  initiatorGenerationId?: string | null;
}): Promise<ChainLineage> => {
  if (!args.initiatorGenerationId) return NO_LINEAGE;

  const chain = await resolveChainContext({
    initiatorGenerationId: args.initiatorGenerationId,
  });
  if (!chain) return NO_LINEAGE;

  return {
    parentTraceId: chain.parentTraceId,
    rootTraceId: chain.rootTraceId,
  };
};

/**
 * Resolves the lineage a turn inherits from its declared initiator, and refuses
 * the turn when the chain that initiator belongs to has spent its budget.
 * Explicit trace ids win — a nested call passes its own, and it is bounded by
 * `max_call_depth` rather than by this.
 */
const refuseChain = async (args: {
  agentId: string;
  projectIds?: number[];
  traceId: string;
  chain: ChainContext;
  initiatorGenerationId?: string | null;
}): Promise<GenerationResult> => {
  const chainAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });
  if (!chainAgent) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.agentId}' not found.`
    );
  }

  log(
    'refuseChain: budget spent initiator=%s size=%d',
    args.initiatorGenerationId,
    args.chain.chainSize
  );

  return buildChainGuardResult({
    traceId: args.traceId,
    projectId: chainAgent.project.id as number,
    projectPublicId: chainAgent.project.publicId,
    agentId: args.agentId,
    generationId: generatePublicId(PUBLIC_ID_PREFIXES.generation),
    parentTraceId: args.chain.parentTraceId,
    rootTraceId: args.chain.rootTraceId,
  });
};

export const resolveChainOrRefuse = async (args: {
  agentId: string;
  projectIds?: number[];
  initiatorGenerationId?: string | null;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<
  | ({ kind: 'ok' } & ChainLineage)
  | { kind: 'refused'; result: GenerationResult }
> => {
  const chain = args.initiatorGenerationId
    ? await resolveChainContext({
        initiatorGenerationId: args.initiatorGenerationId,
      })
    : null;

  if (chain && chain.chainSize >= maxContinuationChainGenerations()) {
    return {
      kind: 'refused',
      result: await refuseChain({
        agentId: args.agentId,
        projectIds: args.projectIds,
        traceId: args.traceId,
        chain,
        initiatorGenerationId: args.initiatorGenerationId,
      }),
    };
  }

  return {
    kind: 'ok',
    parentTraceId: args.parentTraceId ?? chain?.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? chain?.rootTraceId ?? null,
  };
};
