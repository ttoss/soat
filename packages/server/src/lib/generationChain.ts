import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  buildChainGuardResult,
  resolveAgentForGeneration,
} from './agentGenerationRecovery';
import { type GenerationResult } from './agentGenerationTypes';
import { emitChainLimitEvent } from './exceptionAutoFile';

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
  parentTraceId: string | null;
  /** The trace the whole chain is rooted at; the initiator's own when it is the root. */
  rootTraceId: string | null;
  /** The generation the chain is rooted at, which is what the budget counts by. */
  rootGenerationId: string;
  /** Continuations already in this chain, the initiator's own hop included. */
  chainSize: number;
};

/**
 * Resolves the chain a continuation belongs to from the generation it declares
 * as its initiator: the identity it inherits, the trace lineage it is recorded
 * under, and how large the chain already is.
 *
 * All of it is **derived here rather than passed in** so that declaring a parent
 * is the only thing a continuation has to get right — the three paths that seed
 * one had each dropped the trace ids, and a chain whose every hop is an unlinked
 * root is invisible to the guard, to the trace tree, and to anyone reading the
 * incident afterwards.
 *
 * The budget counts by `rootGenerationId`, a plain column this module is the
 * only writer of, rather than by walking trace lineage. Traces are read
 * surfaces, and their lineage is rewritten by operations that know nothing about
 * chains: `deleteAgent` nulls `rootTraceId` on every surviving trace beneath the
 * agent it removes, which re-rooted each hop and handed the chain a fresh budget.
 *
 * An initiator that cannot be resolved **throws**. It has no lineage to inherit
 * and no chain to be counted against, so continuing would start a new one — the
 * unbounded case by another route, and one the caller cannot see, since
 * `createGenerationRecord`'s own refusal is swallowed on this path.
 */
export const resolveChainContext = async (args: {
  initiatorGenerationId: string;
}): Promise<ChainContext> => {
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

  if (!initiator) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${args.initiatorGenerationId}' not found.`
    );
  }

  // A root carries none, so the first continuation names the root itself and
  // every later hop copies what its initiator already holds.
  const rootGenerationId = initiator.rootGenerationId ?? initiator.publicId;

  // Every row carrying this value is a continuation by construction — a nested
  // agent-to-agent call declares no initiator, so it never gets one and is
  // bounded by `max_call_depth` instead.
  const chainSize = await db.Generation.count({ where: { rootGenerationId } });

  const trace = initiator.trace;
  const rootTrace = trace?.rootTrace ?? trace;

  return {
    parentTraceId: trace?.publicId ?? null,
    rootTraceId: rootTrace?.publicId ?? null,
    rootGenerationId,
    chainSize,
  };
};

/** What a hop inherits from its chain; all null when it is not a continuation. */
export type ChainLineage = {
  parentTraceId: string | null;
  rootTraceId: string | null;
  rootGenerationId: string | null;
};

const NO_LINEAGE: ChainLineage = {
  parentTraceId: null,
  rootTraceId: null,
  rootGenerationId: null,
};

/**
 * The chain a continuation inherits from the generation it declares as its
 * initiator, for the paths that seed a suspended generation directly rather
 * than through {@link resolveChainOrRefuse}.
 */
export const resolveChainLineage = async (args: {
  initiatorGenerationId?: string | null;
}): Promise<ChainLineage> => {
  if (!args.initiatorGenerationId) return NO_LINEAGE;

  const chain = await resolveChainContext({
    initiatorGenerationId: args.initiatorGenerationId,
  });

  return {
    parentTraceId: chain.parentTraceId,
    rootTraceId: chain.rootTraceId,
    rootGenerationId: chain.rootGenerationId,
  };
};

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

  const projectId = chainAgent.project.id as number;

  // A refusal nobody is awaiting is a refusal nobody learns about: the
  // resumption that asked for this turn is a background sweep, so the exception
  // is the only thing that reaches a human before the next bill does.
  emitChainLimitEvent({
    projectId,
    projectPublicId: chainAgent.project.publicId,
    agentId: args.agentId,
    rootGenerationId: args.chain.rootGenerationId,
    initiatorGenerationId: args.initiatorGenerationId ?? null,
    chainSize: args.chain.chainSize,
    limit: maxContinuationChainGenerations(),
  });

  return buildChainGuardResult({
    traceId: args.traceId,
    projectId,
    projectPublicId: chainAgent.project.publicId,
    agentId: args.agentId,
    generationId: generatePublicId(PUBLIC_ID_PREFIXES.generation),
    parentTraceId: args.chain.parentTraceId,
    rootTraceId: args.chain.rootTraceId,
  });
};

/**
 * What the turn is recorded under. Explicit trace ids win: a nested call carries
 * its caller's own, and is bounded by `max_call_depth` rather than by the chain
 * budget.
 */
const inheritedLineage = (args: {
  explicit: { parentTraceId?: string | null; rootTraceId?: string | null };
  chain: ChainContext | null;
}): ChainLineage => {
  return {
    parentTraceId:
      args.explicit.parentTraceId ?? args.chain?.parentTraceId ?? null,
    rootTraceId: args.explicit.rootTraceId ?? args.chain?.rootTraceId ?? null,
    rootGenerationId: args.chain?.rootGenerationId ?? null,
  };
};

/**
 * Resolves the chain a turn inherits from its declared initiator, and refuses
 * the turn when that chain has spent its budget.
 */
export const resolveChainOrRefuse = async (args: {
  agentId: string;
  projectIds?: number[];
  initiatorGenerationId?: string | null;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<
  | { kind: 'ok'; lineage: ChainLineage }
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

  return { kind: 'ok', lineage: inheritedLineage({ explicit: args, chain }) };
};
