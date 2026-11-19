import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { agentReferences } from './resourceReferences';
import {
  resolveAgentTraceContentMode,
  ZERO_RETENTION_PRINCIPAL,
} from './traceContentPolicy';
import { replaceTraceSteps } from './traceStepStore';

export { serializeSteps } from './traceStepStore';

const log = createDebug('soat:traces');

/** Redaction columns stamped on a row whose content was never written. Reuses
 * the purge marker deliberately: a reader that already handles "content was
 * erased" needs no new concept, and the principal id says which it was. */
const zeroRetentionColumns = (zeroRetention?: boolean) => {
  if (!zeroRetention) return {};
  return {
    contentRedactedAt: new Date(),
    contentRedactedByPrincipalType: ZERO_RETENTION_PRINCIPAL.principalType,
    contentRedactedByPrincipalId: ZERO_RETENTION_PRINCIPAL.principalId,
  };
};

/**
 * Records a structured error payload on a trace so failed generations are
 * distinguishable from pending ones. Fire-and-forget safe.
 *
 * Suppressed in zero-retention mode. An error payload can carry a
 * tool's request/response bodies — which is exactly why a purge clears
 * `error` — so a mode that promises nothing is written must refuse it here
 * too, or every failed generation would leak the content the mode exists to
 * keep off disk. The row is still stamped, so the failure stays visible as a
 * skeleton even though its payload is not.
 */
export const recordTraceError = async (args: {
  traceId: string;
  error: Record<string, unknown>;
}): Promise<void> => {
  log('recordTraceError: traceId=%s', args.traceId);
  const trace = await db.Trace.findOne({ where: { publicId: args.traceId } });
  if (!trace) return;

  const mode = await resolveAgentTraceContentMode({
    agentDbId: trace.agentId,
    projectDbId: trace.projectId,
  });

  if (mode === 'none') {
    log(
      'recordTraceError: zero-retention, dropping payload for %s',
      args.traceId
    );
    await trace.update({
      error: null,
      ...zeroRetentionColumns(trace.contentRedactedAt === null),
    });
    return;
  }

  // Conditional: a purge that committed first keeps the payload off the row.
  await db.Trace.update(
    { error: args.error },
    { where: { id: trace.id, contentRedactedAt: null } }
  );
};

const findTraceId = async (
  publicId: string | null | undefined
): Promise<number | null> => {
  if (!publicId) return null;
  return ((await db.Trace.findOne({ where: { publicId } }))?.id ?? null) as
    number | null;
};

/** The trace row a write records under, created as a skeleton when missing. */
const ensureTraceRecord = async (args: {
  traceId: string;
  projectId: number;
  agentId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<void> => {
  const existing = await db.Trace.findOne({
    where: { publicId: args.traceId },
  });
  if (existing) return;

  const [agent, parentTraceId, rootTraceId] = await Promise.all([
    // The agent that is running: the project's own, or one shared with it.
    agentReferences.find({
      id: args.agentId,
      projectId: args.projectId,
      reach: 'shares',
    }),
    findTraceId(args.parentTraceId),
    findTraceId(args.rootTraceId),
  ]);
  if (!agent) {
    throw new DomainError(
      'AGENT_NOT_FOUND',
      `Agent '${args.agentId}' not found.`
    );
  }

  log('ensureTraceRecord: creating traceId=%s', args.traceId);
  await db.Trace.findOrCreate({
    where: { publicId: args.traceId },
    defaults: {
      publicId: args.traceId,
      projectId: args.projectId,
      agentId: agent.id as number,
      fileId: null,
      stepCount: 0,
      parentTraceId,
      rootTraceId,
    },
  });
};

/**
 * Makes `steps` the whole of a generation's steps, one object each, creating
 * the trace row when the generation has none. For a turn that records its
 * steps in one write (a guard); a running segment writes each step as it ends
 * (`segmentCallOptions`).
 */
export const saveTrace = async (args: {
  traceId: string;
  projectId: number;
  projectPublicId: string;
  agentId: string;
  generationId: string;
  steps: unknown[];
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<void> => {
  log(
    'saveTrace: traceId=%s generationId=%s steps=%d',
    args.traceId,
    args.generationId,
    args.steps.length
  );
  await ensureTraceRecord(args);
  await replaceTraceSteps({
    target: {
      traceId: args.traceId,
      generationId: args.generationId,
      projectId: args.projectId,
      projectPublicId: args.projectPublicId,
      agentId: args.agentId,
    },
    firstIndex: 0,
    steps: args.steps,
  });
};
