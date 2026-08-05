import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { upsertFileByPath } from './files';
import {
  resolveTraceContentModeForAgent,
  ZERO_RETENTION_PRINCIPAL,
} from './traceContentPolicy';

const log = createDebug('soat:traces');

/**
 * Serializes trace steps so that Error objects (which serialize to `{}` by
 * default) are converted to plain objects with `message`, `name`, and any
 * enumerable properties (e.g. `status`, `body` from HttpToolError).
 */
export const serializeSteps = (steps: unknown[]): unknown[] => {
  return JSON.parse(
    JSON.stringify(steps, (_key, value: unknown) => {
      if (value instanceof Error) {
        return {
          message: value.message,
          name: value.name,
          ...(value as unknown as Record<string, unknown>),
        };
      }
      return value;
    })
  ) as unknown[];
};

/**
 * Records a structured error payload on a trace so failed generations are
 * distinguishable from pending ones. Fire-and-forget safe.
 */
export const recordTraceError = async (args: {
  traceId: string;
  error: Record<string, unknown>;
}): Promise<void> => {
  log('recordTraceError: traceId=%s', args.traceId);
  const trace = await db.Trace.findOne({ where: { publicId: args.traceId } });
  if (!trace) return;
  await trace.update({ error: args.error });
};

const findTraceId = async (
  publicId: string | null | undefined
): Promise<number | null> => {
  if (!publicId) return null;
  return ((await db.Trace.findOne({ where: { publicId } }))?.id ?? null) as
    number | null;
};

const findFileId = async (
  publicId: string | null | undefined
): Promise<number | null> => {
  if (!publicId) return null;
  return ((await db.File.findOne({ where: { publicId } }))?.id ?? null) as
    number | null;
};

type CreateTraceArgs = {
  traceId: string;
  projectId: number;
  agentId: number;
  fileId: number | null;
  stepCount: number;
  parentTraceId: number | null;
  rootTraceId: number | null;
  zeroRetention?: boolean;
};

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

const createTraceOrFallback = async (args: CreateTraceArgs): Promise<void> => {
  try {
    await db.Trace.create({
      publicId: args.traceId,
      projectId: args.projectId,
      agentId: args.agentId,
      fileId: args.fileId,
      stepCount: args.stepCount,
      parentTraceId: args.parentTraceId,
      rootTraceId: args.rootTraceId,
      ...zeroRetentionColumns(args.zeroRetention),
    });
  } catch (createError) {
    // Handle race condition: another process may have created the record concurrently.
    const concurrent = await db.Trace.findOne({
      where: { publicId: args.traceId },
    });
    if (concurrent) {
      log(
        'upsertTraceRecord: concurrent create detected, updating traceId=%s',
        args.traceId
      );
      await concurrent.update({
        fileId: args.fileId,
        stepCount: args.stepCount,
        ...zeroRetentionColumns(args.zeroRetention),
      });
    } else {
      throw createError;
    }
  }
};

const upsertTraceRecord = async (args: {
  traceId: string;
  projectId: number;
  agentId: string;
  filePublicId: string | undefined | null;
  stepCount: number;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  zeroRetention?: boolean;
}): Promise<void> => {
  log(
    'upsertTraceRecord: traceId=%s agentId=%s parentTraceId=%s rootTraceId=%s stepCount=%d',
    args.traceId,
    args.agentId,
    args.parentTraceId ?? 'null',
    args.rootTraceId ?? 'null',
    args.stepCount
  );

  const existing = await db.Trace.findOne({
    where: { publicId: args.traceId },
  });

  const [agent, fileId, parentTraceDbId, rootTraceDbId] = await Promise.all([
    db.Agent.findOne({
      where: { publicId: args.agentId, projectId: args.projectId },
    }),
    findFileId(args.filePublicId),
    findTraceId(args.parentTraceId),
    findTraceId(args.rootTraceId),
  ]);

  if (!agent) {
    throw new DomainError(
      'AGENT_NOT_FOUND',
      `Agent '${args.agentId}' not found.`
    );
  }

  if (existing) {
    log('upsertTraceRecord: updating existing trace traceId=%s', args.traceId);
    await existing.update({
      fileId,
      stepCount: args.stepCount,
      ...zeroRetentionColumns(args.zeroRetention),
    });
  } else {
    log('upsertTraceRecord: creating new trace traceId=%s', args.traceId);
    await createTraceOrFallback({
      traceId: args.traceId,
      projectId: args.projectId,
      agentId: agent.id as number,
      fileId,
      stepCount: args.stepCount,
      parentTraceId: parentTraceDbId,
      rootTraceId: rootTraceDbId,
      zeroRetention: args.zeroRetention,
    });
  }
};

/**
 * Upserts a Trace row in the DB and writes trace content (steps) to disk
 * via the File system. The file is stored at `/traces/{traceId}.json` under
 * the project's storage directory.
 *
 * Fire-and-forget safe: callers may not await this.
 */
export const saveTrace = async (args: {
  traceId: string;
  projectId: number;
  projectPublicId: string;
  agentId: string;
  steps: unknown[];
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<void> => {
  log(
    'saveTrace: traceId=%s agentId=%s parentTraceId=%s rootTraceId=%s steps=%d',
    args.traceId,
    args.agentId,
    args.parentTraceId ?? 'null',
    args.rootTraceId ?? 'null',
    args.steps.length
  );
  const serializedSteps = serializeSteps(args.steps);

  // Zero-retention (#838): the steps object is never written, so there are no
  // bytes to leak, to miss in a sweep, or to sit in a backup. The skeleton row
  // is still upserted — a run stays auditable and attributable for billing —
  // and is stamped with the same redaction columns a purge sets, so every
  // reader already understands "content is not available here".
  const mode = await resolveTraceContentModeForAgent({
    projectDbId: args.projectId,
    agentPublicId: args.agentId,
  });

  if (mode === 'none') {
    log(
      'saveTrace: zero-retention, skipping steps file traceId=%s',
      args.traceId
    );
    await upsertTraceRecord({
      traceId: args.traceId,
      projectId: args.projectId,
      agentId: args.agentId,
      filePublicId: null,
      // A counter, not content: step_count is part of the skeleton.
      stepCount: serializedSteps.length,
      parentTraceId: args.parentTraceId ?? null,
      rootTraceId: args.rootTraceId ?? null,
      zeroRetention: true,
    });
    return;
  }

  const content = Buffer.from(JSON.stringify(serializedSteps), 'utf8');
  const filePath = `/traces/${args.traceId}.json`;

  const fileRecord = await upsertFileByPath({
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    path: filePath,
    fileBuffer: content,
    contentType: 'application/json',
    filename: `${args.traceId}.json`,
  });

  await upsertTraceRecord({
    traceId: args.traceId,
    projectId: args.projectId,
    agentId: args.agentId,
    filePublicId: fileRecord.id,
    stepCount: serializedSteps.length,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
  });
};
