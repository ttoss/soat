import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { upsertFileByPath } from './files';
import { readFileBuffer } from './fileStorage';
import {
  resolveAgentTraceContentMode,
  resolveTraceContentModeForAgent,
  ZERO_RETENTION_PRINCIPAL,
} from './traceContentPolicy';
import {
  applySegment,
  locateSegment,
  readStepSegments,
  type StepSegment,
  totalSegmentSteps,
} from './traceStepSegments';

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
 * Suppressed in zero-retention mode (#838). An error payload can carry a
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
  stepSegments: StepSegment[];
  parentTraceId: number | null;
  rootTraceId: number | null;
  zeroRetention?: boolean;
};

const createTraceOrFallback = async (args: CreateTraceArgs): Promise<void> => {
  try {
    await db.Trace.create({
      publicId: args.traceId,
      projectId: args.projectId,
      agentId: args.agentId,
      fileId: args.fileId,
      stepCount: args.stepCount,
      stepSegments: args.stepSegments,
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
        stepSegments: args.stepSegments,
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
  stepSegments: StepSegment[];
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
      stepSegments: args.stepSegments,
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
      stepSegments: args.stepSegments,
      parentTraceId: parentTraceDbId,
      rootTraceId: rootTraceDbId,
      zeroRetention: args.zeroRetention,
    });
  }
};

type SaveTraceArgs = {
  traceId: string;
  projectId: number;
  projectPublicId: string;
  agentId: string;
  /**
   * The generation these steps belong to. It is what makes a `trace_id` shared
   * by several generations safe: the call owns one segment of the steps object
   * and can never write over another generation's (#1024).
   */
  generationId: string;
  /** Every step of `generationId` so far — a resumed turn passes its earlier
   * steps again, and they replace, rather than duplicate, the ones on disk. */
  steps: unknown[];
  parentTraceId?: string | null;
  rootTraceId?: string | null;
};

/**
 * Reads the trace's steps object back. Returns `null` when there is nothing to
 * read — no row, no file, or bytes that are not a JSON array — which the caller
 * treats as "start the object over", so the segment index can never describe
 * content that is not there.
 */
const readTraceSteps = async (
  trace: InstanceType<(typeof db)['Trace']> | null
): Promise<unknown[] | null> => {
  if (!trace?.fileId) return null;

  const file = await db.File.findOne({ where: { id: trace.fileId } });
  if (!file?.storagePath) return null;

  const buffer = await readFileBuffer({
    storagePath: file.storagePath,
    storageType: file.storageType,
  });
  if (!buffer) return null;

  try {
    const parsed: unknown = JSON.parse(buffer.toString('utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    log('readTraceSteps: unparseable steps object traceId=%s', trace.publicId);
    return null;
  }
};

/**
 * Serializes the writes for one trace within this process, so two generations
 * grouped under the same `trace_id` cannot interleave their read-modify-write
 * of the steps object and lose one of them.
 *
 * In-process only, and deliberately so: the alternative is holding a row lock
 * across a storage write. Concurrent generations on one `trace_id` served by
 * *different* server processes can still race — a much narrower window than the
 * unconditional overwrite this replaces, and grouping is a single-caller flow.
 */
const traceWrites = new Map<string, Promise<void>>();

const withTraceWriteLock = async <T>(
  traceId: string,
  run: () => Promise<T>
): Promise<T> => {
  const previous = traceWrites.get(traceId) ?? Promise.resolve();

  const { promise: held, resolve: release } = Promise.withResolvers<void>();

  const chained = previous.then(() => {
    return held;
  });
  traceWrites.set(traceId, chained);

  await previous;

  try {
    return await run();
  } finally {
    release();
    void chained.then(() => {
      if (traceWrites.get(traceId) === chained) traceWrites.delete(traceId);
    });
  }
};

/**
 * The steps object and index a write builds on.
 *
 * Both come back empty unless they agree with each other, so the object and its
 * index can never describe different histories. They disagree in two cases:
 *
 * - nothing readable to build on (no file, or unparseable bytes);
 * - content written before the object was segmented, whose steps cannot be
 *   attributed to a generation. That write is replaced exactly as it was before
 *   this change, and the trace is indexed from here on.
 */
const readTraceBase = async (
  trace: InstanceType<(typeof db)['Trace']> | null
): Promise<{ baseSteps: unknown[]; baseSegments: StepSegment[] }> => {
  const storedSteps = await readTraceSteps(trace);
  const storedSegments = readStepSegments(trace?.stepSegments);

  const indexed =
    storedSteps !== null &&
    (storedSegments.length > 0 || storedSteps.length === 0);

  return indexed
    ? { baseSteps: storedSteps, baseSegments: storedSegments }
    : { baseSteps: [], baseSegments: [] };
};

const writeTrace = async (args: SaveTraceArgs): Promise<void> => {
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

  const existingTrace = await db.Trace.findOne({
    where: { publicId: args.traceId },
  });

  if (mode === 'none') {
    log(
      'saveTrace: zero-retention, skipping steps file traceId=%s',
      args.traceId
    );
    // The segment index is counters and ids, so it is skeleton like
    // `step_count` and stays accurate even with no object behind it.
    const segments = applySegment({
      segments: readStepSegments(existingTrace?.stepSegments),
      generationId: args.generationId,
      stepCount: serializedSteps.length,
    });

    await upsertTraceRecord({
      traceId: args.traceId,
      projectId: args.projectId,
      agentId: args.agentId,
      filePublicId: null,
      // A counter, not content: step_count is part of the skeleton.
      stepCount: totalSegmentSteps(segments),
      stepSegments: segments,
      parentTraceId: args.parentTraceId ?? null,
      rootTraceId: args.rootTraceId ?? null,
      zeroRetention: true,
    });
    return;
  }

  const { baseSteps, baseSegments } = await readTraceBase(existingTrace);

  const { offset, stepCount: previousCount } = locateSegment(
    baseSegments,
    args.generationId
  );
  const mergedSteps = [
    ...baseSteps.slice(0, offset),
    ...serializedSteps,
    ...baseSteps.slice(offset + previousCount),
  ];
  const segments = applySegment({
    segments: baseSegments,
    generationId: args.generationId,
    stepCount: serializedSteps.length,
  });

  const content = Buffer.from(JSON.stringify(mergedSteps), 'utf8');
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
    stepCount: mergedSteps.length,
    stepSegments: segments,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
  });
};

/**
 * Upserts a Trace row in the DB and writes trace content (steps) to disk
 * via the File system. The file is stored at `/traces/{traceId}.json` under
 * the project's storage directory.
 *
 * The object is the concatenation of one segment per generation grouped under
 * the trace, indexed by `Trace.stepSegments`. A call rewrites only its own
 * generation's segment, so the documented "group generations under one
 * `trace_id`" flow keeps every turn instead of leaving the last writer's steps
 * as the whole trace (#1024), and `step_count` counts them all.
 *
 * Fire-and-forget safe: callers may not await this.
 */
export const saveTrace = async (args: SaveTraceArgs): Promise<void> => {
  log(
    'saveTrace: traceId=%s generationId=%s agentId=%s parentTraceId=%s rootTraceId=%s steps=%d',
    args.traceId,
    args.generationId,
    args.agentId,
    args.parentTraceId ?? 'null',
    args.rootTraceId ?? 'null',
    args.steps.length
  );

  return withTraceWriteLock(args.traceId, () => {
    return writeTrace(args);
  });
};
