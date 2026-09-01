import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  buildChainGuardResult,
  resolveAgentForGeneration,
} from './agentGenerationRecovery';
import type { GenerationResult, TypedAgent } from './agentGenerationTypes';
import { resolveChainGenerationCeiling } from './agentStopConditions';
import { emitChainLimitEvent } from './exceptionAutoFile';
import { findOrCreateChain, markChainStatus } from './generationChains';

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

/**
 * The deployment-wide ceiling. An agent may declare a smaller one of its own
 * (`stop_conditions`: `maxChainGenerations`); the effective budget is the
 * smaller of the two, so this stays a backstop rather than a target.
 */
export const maxContinuationChainGenerations = (): number => {
  const configured = Number(process.env.MAX_CONTINUATION_CHAIN_GENERATIONS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_CONTINUATION_CHAIN_GENERATIONS;
};

/**
 * The project's own chain ceiling, or `null` when it sets none. Guarded rather
 * than trusted: the value reaches here on a row loaded through `TypedAgent`,
 * and a config rebuilt from an archived version carries no project columns.
 */
const readProjectCeiling = (agent: TypedAgent | null): number | null => {
  const declared = agent?.project?.maxChainGenerations;
  return typeof declared === 'number' &&
    Number.isInteger(declared) &&
    declared > 0
    ? declared
    : null;
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

/** The initiator row plus the associations the chain is derived from. */
const loadInitiator = async (initiatorGenerationId: string) => {
  const initiator = await db.Generation.findOne({
    where: { publicId: initiatorGenerationId },
    include: [
      {
        model: db.Trace,
        as: 'trace',
        include: [{ model: db.Trace, as: 'rootTrace' }],
      },
      // Only to name the chain's opening agent on its row; the guard itself
      // needs nothing from it.
      { model: db.Agent, as: 'agent', attributes: ['publicId'] },
    ],
  });

  if (!initiator) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${initiatorGenerationId}' not found.`
    );
  }
  return initiator;
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
 *
 * Also where the chain's own row is created, lazily, on the first continuation
 * (`generationChains.ts`) — before the hop is authorized, so a hop that is then
 * refused still leaves the record that says why the chain stopped.
 */
export const resolveChainContext = async (args: {
  initiatorGenerationId: string;
}): Promise<ChainContext> => {
  const initiator = await loadInitiator(args.initiatorGenerationId);

  // A root carries none, so the first continuation names the root itself and
  // every later hop copies what its initiator already holds.
  const rootGenerationId = initiator.rootGenerationId ?? initiator.publicId;

  // Every row carrying this value is a continuation by construction — a nested
  // agent-to-agent call declares no initiator, so it never gets one and is
  // bounded by `max_call_depth` instead.
  const chainSize = await db.Generation.count({ where: { rootGenerationId } });

  const trace = initiator.trace;
  const rootTrace = trace?.rootTrace ?? trace;

  // Created here rather than after the hop commits, so a hop that is then
  // *refused* still leaves the row that says why the chain stopped. Best-effort
  // by construction (`generationChains.ts`) — the budget above is what enforces.
  await findOrCreateChain({
    projectId: initiator.projectId,
    agentId: initiator.agent?.publicId ?? null,
    rootGenerationId,
    memberCount: chainSize + 1,
  });

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

/** Which ceiling refused the hop — the agent's, its project's, or the deployment's. */
type LimitSource = 'agent' | 'project' | 'platform';

const refuseChain = async (args: {
  agentId: string;
  chainAgent: TypedAgent | null;
  traceId: string;
  chain: ChainContext;
  limit: number;
  limitSource: LimitSource;
  initiatorGenerationId?: string | null;
}): Promise<GenerationResult> => {
  const { chainAgent } = args;
  // Only the refusal needs the agent, and only to name the project on the guard
  // result — so an unresolvable agent still throws here and nowhere else, which
  // keeps the error a continuation to a missing agent produces unchanged.
  if (!chainAgent) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.agentId}' not found.`
    );
  }

  log(
    'refuseChain: budget spent initiator=%s size=%d limit=%d source=%s',
    args.initiatorGenerationId,
    args.chain.chainSize,
    args.limit,
    args.limitSource
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
    limit: args.limit,
    limitSource: args.limitSource,
  });

  // The chain's own row carries the ending too: an exception is a triage item
  // that a human resolves and closes, while this is the state of the chain.
  await markChainStatus({
    rootGenerationId: args.chain.rootGenerationId,
    status: 'budget_exhausted',
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
 * The budget this hop is actually held to: the smallest of the deployment's
 * ceiling, the project's, and the agent's own declared one.
 *
 * `min` rather than "the innermost if set": each narrower scope exists so its
 * owner can be *stricter* than the one above, and letting any of them raise a
 * ceiling would make the outer bound opt-out — which is the one thing it cannot
 * be, since the agent that runs away is exactly the one whose config is wrong.
 * So a project owner bounds every chain in the project without an agent author's
 * cooperation, and an author can still be stricter than that.
 *
 * Ties go outward (`<`, not `<=`): where two scopes name the same number, the
 * broader one is reported, because raising the inner one alone would not move
 * the budget and saying otherwise would send the reader to the wrong knob.
 */
const resolveEffectiveLimit = (
  agent: TypedAgent | null
): { limit: number; limitSource: LimitSource } => {
  const platform = maxContinuationChainGenerations();

  // Read from the project row at spawn time, for the same reason the agent's
  // own ceiling is: a chain can span days, and lowering the number has to be
  // able to stop one that is already running away.
  const project = readProjectCeiling(agent);
  const declared = agent
    ? resolveChainGenerationCeiling(agent.stopConditions)
    : null;

  let limit = platform;
  let limitSource: LimitSource = 'platform';
  if (project !== null && project < limit) {
    limit = project;
    limitSource = 'project';
  }
  if (declared !== null && declared < limit) {
    limit = declared;
    limitSource = 'agent';
  }
  return { limit, limitSource };
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
  if (!args.initiatorGenerationId) {
    return {
      kind: 'ok',
      lineage: inheritedLineage({ explicit: args, chain: null }),
    };
  }

  const chain = await resolveChainContext({
    initiatorGenerationId: args.initiatorGenerationId,
  });

  // Loaded once, here, rather than only on the refusal path: the agent's own
  // ceiling is part of the decision now, and the refusal reuses this instance.
  // A null agent is deliberately not an error yet — the context builder owns
  // that failure, and pre-empting it here would change the code a caller gets
  // for a continuation naming a missing agent.
  const chainAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });

  const { limit, limitSource } = resolveEffectiveLimit(chainAgent);

  if (chain.chainSize >= limit) {
    return {
      kind: 'refused',
      result: await refuseChain({
        agentId: args.agentId,
        chainAgent,
        traceId: args.traceId,
        chain,
        limit,
        limitSource,
        initiatorGenerationId: args.initiatorGenerationId,
      }),
    };
  }

  return { kind: 'ok', lineage: inheritedLineage({ explicit: args, chain }) };
};
