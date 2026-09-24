/**
 * At-most-once agent generations; the claim itself is `idempotencyClaim.ts`.
 * The key is claimed by the generation record, so it lives exactly as long as
 * that record does.
 */
import createDebug from 'debug';

import { db } from '../db';
import { agents } from './agentAccessor';
import type { CreateGenerationArgs } from './agentGeneration';
import { claimIdempotencyKey, idempotencyKeyReused } from './idempotencyClaim';
import { stableDigest } from './stableDigest';

const log = createDebug('soat:generation');

/** What the generation record claims: the key and the request it names. */
export type GenerationIdempotency = { key: string; digest: string };

/**
 * The handle of the generation a claimed key names, in the shape of a
 * background start: its output is on the trace, not the record, so a replay
 * points at the generation instead of repeating a result it cannot rebuild.
 */
export type ReplayedGeneration = {
  id: string;
  traceId: string;
  status: 'accepted';
  idempotent: true;
};

/**
 * The digest of the request fields a key names. `stream` and `wait` are not
 * among them: they say how the caller receives the generation, not what it is,
 * so a retry may flip them.
 */
export const generationRequestDigest = (args: CreateGenerationArgs): string => {
  return stableDigest({
    agentId: args.agentId,
    messages: args.messages,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
    toolContext: args.toolContext,
    knowledgeConfig: args.knowledgeConfig,
    actionId: args.actionId,
    metadata: args.metadata,
    guardrailContext: args.guardrailContext,
  });
};

/**
 * The generation a claimed key names, or `null` when the key is unclaimed. A
 * retry arriving while the original is still running finds the record already
 * written — it is written before the provider is called — so the retry replays
 * the generation in flight instead of blocking or refusing.
 */
export const replayIdempotentGeneration = async (args: {
  agentId: string;
  projectIds?: number[];
  idempotency: GenerationIdempotency;
}): Promise<ReplayedGeneration | null> => {
  const agent = await agents.getByPublicId({
    id: args.agentId,
    projectIds: args.projectIds,
  });
  const generation = await db.Generation.findOne({
    where: {
      projectId: agent.projectId,
      idempotencyKey: args.idempotency.key,
    },
    include: [{ model: db.Trace, as: 'trace' }],
  });
  if (!generation) return null;

  if (generation.idempotencyDigest !== args.idempotency.digest) {
    log(
      'replayIdempotentGeneration: key=%s claimed by generation=%s with a different request',
      args.idempotency.key,
      generation.publicId
    );
    throw idempotencyKeyReused({
      idempotencyKey: args.idempotency.key,
      claimedBy: 'generation',
    });
  }

  log(
    'replayIdempotentGeneration: key=%s generation=%s',
    args.idempotency.key,
    generation.publicId
  );
  return {
    id: generation.publicId,
    traceId: generation.trace.publicId,
    status: 'accepted',
    idempotent: true,
  };
};

/** A generation request as the route receives it: optionally keyed. */
export type RequestedGenerationArgs = CreateGenerationArgs & {
  idempotencyKey?: string;
};

/**
 * `prepare`'s result for a new generation, or the replay of the one the key
 * already names. Checked before `prepare` builds any context: resolving a
 * `tool_output` message runs its tool, which a replay must not repeat.
 */
export const claimKeyedGeneration = async <Prep>(args: {
  request: RequestedGenerationArgs;
  prepare: (request: CreateGenerationArgs) => Promise<Prep>;
}): Promise<Prep | { kind: 'replay'; replayed: ReplayedGeneration }> => {
  const { request } = args;
  if (!request.idempotencyKey) return args.prepare(request);

  const idempotency = {
    key: request.idempotencyKey,
    digest: generationRequestDigest(request),
  };
  const claimed = await claimIdempotencyKey({
    replay: () => {
      return replayIdempotentGeneration({
        agentId: request.agentId,
        projectIds: request.projectIds,
        idempotency,
      });
    },
    create: () => {
      return args.prepare({ ...request, idempotency });
    },
  });
  return 'replayed' in claimed
    ? { kind: 'replay', replayed: claimed.replayed }
    : claimed.created;
};
