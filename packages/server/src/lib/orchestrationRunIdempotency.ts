/**
 * At-most-once run starts.
 *
 * Starting a run is the most expensive mutating POST in the API — it spends
 * model tokens — so an ambiguous timeout on it is the one a caller most needs
 * to be able to retry. The key is claimed by the run row itself and stays
 * claimed for as long as that row exists: a window that expired would put back
 * exactly the doubt this removes.
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { mapRunWithIncludes } from './orchestrationRunHelpers';
import type { MappedOrchestrationRun } from './orchestrations';

const log = createDebug('soat:orchestrations');

/**
 * A started run, plus the marker the route reads to tell a fresh start (`201`)
 * from a replay (`200`). The marker never reaches the wire.
 */
export type StartedOrchestrationRun = MappedOrchestrationRun & {
  idempotent?: true;
};

/**
 * The request fields a key names. `wait` is deliberately not among them: it
 * says how the caller waits for the run, not what the run is, so a retry may
 * flip it.
 */
export type IdempotentRunRequest = {
  orchestrationId: number;
  input?: Record<string, unknown>;
  toolContext?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

const sameJson = (a: unknown, b: unknown): boolean => {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
};

export const findRunByIdempotencyKey = async (args: {
  projectId: number;
  idempotencyKey: string;
}): Promise<InstanceType<typeof db.OrchestrationRun> | null> => {
  return db.OrchestrationRun.findOne({
    where: {
      projectId: args.projectId,
      idempotencyKey: args.idempotencyKey,
    },
  });
};

/**
 * Refuses a key reused for a different request. Replaying the original run
 * under a body the caller did not send would hand back a run that does not do
 * what they just asked for, which is worse than refusing.
 */
export const assertIdempotentRequestMatches = (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
  request: IdempotentRunRequest;
  idempotencyKey: string;
}): void => {
  const { run, request } = args;
  const matches =
    run.orchestrationId === request.orchestrationId &&
    sameJson(run.input, request.input) &&
    sameJson(run.toolContext, request.toolContext) &&
    sameJson(run.metadata, request.metadata);

  if (matches) return;

  log(
    'assertIdempotentRequestMatches: key=%s claimed by run=%s with a different request',
    args.idempotencyKey,
    run.publicId
  );
  throw new DomainError(
    'IDEMPOTENCY_KEY_REUSED',
    `Idempotency key '${args.idempotencyKey}' is already claimed by a run started from a different request.`,
    { idempotency_key: args.idempotencyKey }
  );
};

/**
 * The stored run a claimed key names, mapped for the wire and flagged so the
 * route answers `200` rather than `201`. `null` when the key is unclaimed.
 *
 * A retry that arrives while the original request is still driving finds the
 * row already written — `createRunRecord` writes it before any node executes —
 * so the retry replays the run in flight instead of blocking or refusing.
 */
export const replayIdempotentRun = async (args: {
  projectId: number;
  idempotencyKey: string;
  request: IdempotentRunRequest;
}): Promise<StartedOrchestrationRun | null> => {
  const run = await findRunByIdempotencyKey({
    projectId: args.projectId,
    idempotencyKey: args.idempotencyKey,
  });
  if (!run) return null;

  assertIdempotentRequestMatches({
    run,
    request: args.request,
    idempotencyKey: args.idempotencyKey,
  });

  log('replayIdempotentRun: key=%s run=%s', args.idempotencyKey, run.publicId);
  return {
    ...(await mapRunWithIncludes(run.id as number)),
    idempotent: true,
  };
};
