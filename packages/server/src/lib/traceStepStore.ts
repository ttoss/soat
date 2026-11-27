/**
 * A trace's step content: one object per step, at
 * `/.system/traces/{trace}/{generation}/{index}.json`. A write never reads
 * another object, so generations sharing a `trace_id` cannot lose each other's
 * steps on any process; a trace read concatenates them.
 *
 * Every content write checks the content mode and both redaction markers, then
 * checks the markers again once the object landed: a purge that committed in
 * between may have listed the directory before it, so the writer deletes it.
 */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { pathPrefixPattern, systemPath } from './filePaths';
import { upsertFileByPath } from './files';
import { deleteStorageObjects, readFileBuffer } from './fileStorage';
import { loggableError } from './loggableError';
import { principalColumns } from './principals';
import {
  resolveTraceContentModeForAgent,
  ZERO_RETENTION_PRINCIPAL,
} from './traceContentPolicy';
import { splitVendorOptions } from './vendorOptions';

const log = createDebug('soat:traces');

const OMITTED_PREFIX = '[omitted:';

const STEP_INDEX_DIGITS = 6;

// Nothing replays a step, so its messages' vendor options are not kept.
const withoutVendorOptions = (
  response: Record<string, unknown>
): Record<string, unknown> => {
  if (!Array.isArray(response.messages)) return response;
  return {
    ...response,
    messages: splitVendorOptions({ messages: response.messages }).messages,
  };
};

const withoutProviderModel = (step: unknown): unknown => {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
  const { model: _model, ...rest } = Object.fromEntries(Object.entries(step));
  const { response } = rest;
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return rest;
  }
  const { modelId: _modelId, ...responseRest } = Object.fromEntries(
    Object.entries(response)
  );
  return { ...rest, response: withoutVendorOptions(responseRest) };
};

/**
 * Serializes trace steps so that Error objects (which serialize to `{}` by
 * default) are converted to plain objects with `message`, `name`, and any
 * enumerable properties (e.g. `status`, `body` from HttpToolError).
 *
 * A file's `data_base64` (a tool's file argument or `response_mode: base64`
 * answer) is replaced by its size: a trace records the call, not the file.
 *
 * A step's `model` and `response.modelId` are dropped: they name the provider's
 * own model id, not the model the generation was asked for. So are the vendor
 * options on `response.messages` (`vendorOptions.ts`).
 */
export const serializeSteps = (steps: unknown[]): unknown[] => {
  const parsed = JSON.parse(
    JSON.stringify(steps, (key, value: unknown) => {
      // A step serialized once passes through again; keep the size.
      if (
        key === 'data_base64' &&
        typeof value === 'string' &&
        !value.startsWith(OMITTED_PREFIX)
      ) {
        return `${OMITTED_PREFIX} ${Buffer.byteLength(value, 'base64')} bytes]`;
      }
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
  return parsed.map(withoutProviderModel);
};

/** The generation whose steps a write records, and where they are stored. */
export type TraceStepTarget = {
  traceId: string;
  generationId: string;
  projectId: number;
  projectPublicId: string;
  agentId: string;
};

/** The target of a turn's first segment, from the ids its run carries. */
export const turnStepTarget = (args: {
  traceId: string;
  generationId: string;
  agentId: string;
  typedAgent: { project: { id: number; publicId: string } };
}): TraceStepTarget => {
  return {
    traceId: args.traceId,
    generationId: args.generationId,
    projectId: args.typedAgent.project.id,
    projectPublicId: args.typedAgent.project.publicId,
    agentId: args.agentId,
  };
};

const traceDirectory = (traceId: string) => {
  return systemPath({ module: 'traces', leaf: traceId });
};

const generationDirectory = (target: TraceStepTarget) => {
  return systemPath({
    module: 'traces',
    leaf: `${target.traceId}/${target.generationId}`,
  });
};

const stepPath = (args: { target: TraceStepTarget; index: number }) => {
  const name = String(args.index).padStart(STEP_INDEX_DIGITS, '0');
  return systemPath({
    module: 'traces',
    leaf: `${args.target.traceId}/${args.target.generationId}/${name}.json`,
  });
};

/** The generation and step index a step object's path names. */
const parseStepPath = (
  path: string | null
): { generationId: string; index: number } | null => {
  const match = /\/([^/]+)\/(\d+)\.json$/.exec(path ?? '');
  if (!match) return null;
  return { generationId: match[1], index: Number(match[2]) };
};

type StepFile = InstanceType<(typeof db)['File']>;

const findStepFiles = async (args: {
  projectId: number;
  directory: string;
}): Promise<StepFile[]> => {
  return db.File.findAll({
    where: {
      projectId: args.projectId,
      path: { [Op.like]: pathPrefixPattern(args.directory) },
    },
    attributes: ['id', 'path', 'storagePath', 'storageType'],
    order: [['path', 'ASC']],
  });
};

/** Rows first, then bytes, so no read references an object mid-delete. */
export const destroyStepFiles = async (files: StepFile[]): Promise<void> => {
  if (files.length === 0) return;
  await db.File.destroy({
    where: {
      id: files.map((file) => {
        return file.id as number;
      }),
    },
  });
  await deleteStorageObjects(
    files.map((file) => {
      return { storagePath: file.storagePath, storageType: file.storageType };
    })
  );
};

/** Every step object stored under the traces, for a purge or a delete. */
export const findTraceStepFiles = async (args: {
  traces: Array<{ projectId: number; publicId: string }>;
}): Promise<StepFile[]> => {
  const found = await Promise.all(
    args.traces.map((trace) => {
      return findStepFiles({
        projectId: trace.projectId,
        directory: traceDirectory(trace.publicId),
      });
    })
  );
  return found.flat();
};

/**
 * Sets the generation's step count and moves its trace's `stepCount` by the
 * difference. One writer per generation (its lease), so read-then-write holds;
 * the trace's counter moves by an atomic increment, as many generations share
 * it.
 */
const recordStepCount = async (args: {
  target: TraceStepTarget;
  next: (previous: number) => number;
}): Promise<void> => {
  const generation = await db.Generation.findOne({
    where: { publicId: args.target.generationId },
    attributes: ['id', 'stepCount'],
  });
  // No row: the generation was deleted, and its steps count nowhere.
  if (!generation) return;
  const previous = generation.stepCount ?? 0;
  const count = args.next(previous);
  if (count === previous) return;
  await db.Generation.update(
    { stepCount: count },
    { where: { id: generation.id } }
  );
  await db.Trace.increment('stepCount', {
    by: count - previous,
    where: { publicId: args.target.traceId, projectId: args.target.projectId },
  });
};

const contentRedacted = async (target: TraceStepTarget): Promise<boolean> => {
  const [trace, generation] = await Promise.all([
    db.Trace.findOne({
      where: { publicId: target.traceId, projectId: target.projectId },
      attributes: ['contentRedactedAt'],
    }),
    db.Generation.findOne({
      where: { publicId: target.generationId },
      attributes: ['contentRedactedAt'],
    }),
  ]);
  // A missing row was deleted with its content: fail closed.
  if (!trace || !generation) return true;
  return (
    trace.contentRedactedAt !== null || generation.contentRedactedAt !== null
  );
};

/** Stamps a zero-retention trace as never holding content; a trace already
 * redacted keeps its stamp. */
export const stampZeroRetentionTrace = async (where: {
  publicId: string;
  projectId: number;
}): Promise<void> => {
  await db.Trace.update(
    {
      contentRedactedAt: new Date(),
      ...principalColumns({
        prefix: 'contentRedactedBy',
        principal: ZERO_RETENTION_PRINCIPAL,
      }),
    },
    { where: { ...where, contentRedactedAt: null } }
  );
};

/** Whether content may be written; stamps a zero-retention trace. */
const contentWritable = async (target: TraceStepTarget): Promise<boolean> => {
  const mode = await resolveTraceContentModeForAgent({
    projectDbId: target.projectId,
    agentPublicId: target.agentId,
  });
  if (mode !== 'none') return !(await contentRedacted(target));

  await stampZeroRetentionTrace({
    publicId: target.traceId,
    projectId: target.projectId,
  });
  return false;
};

const writeStepObjects = async (args: {
  target: TraceStepTarget;
  firstIndex: number;
  steps: unknown[];
}): Promise<void> => {
  if (args.steps.length === 0) return;
  if (!(await contentWritable(args.target))) return;

  const serialized = serializeSteps(args.steps);
  for (const [offset, step] of serialized.entries()) {
    await upsertFileByPath({
      projectId: args.target.projectId,
      projectPublicId: args.target.projectPublicId,
      path: stepPath({ target: args.target, index: args.firstIndex + offset }),
      fileBuffer: Buffer.from(JSON.stringify(step), 'utf8'),
      contentType: 'application/json',
    });
  }

  if (await contentRedacted(args.target)) {
    log('writeStepObjects: purged mid-write %s', args.target.generationId);
    await destroyStepFiles(
      await findStepFiles({
        projectId: args.target.projectId,
        directory: generationDirectory(args.target),
      })
    );
  }
};

/** Writes `steps` from `firstIndex` on, leaving every other object as it is. */
export const writeTraceSteps = async (args: {
  target: TraceStepTarget;
  firstIndex: number;
  steps: unknown[];
}): Promise<void> => {
  const end = args.firstIndex + args.steps.length;
  await recordStepCount({
    target: args.target,
    next: (previous) => {
      return Math.max(previous, end);
    },
  });
  await writeStepObjects(args);
};

/**
 * Records one step a running segment just ended, at `firstIndex + stepNumber`
 * (`firstIndex`: the steps the turn spent before the segment). Never throws: a
 * lost write is logged and the generation goes on.
 */
export const writeTraceStep = async (args: {
  target: TraceStepTarget;
  firstIndex: number;
  stepNumber: number;
  step: unknown;
}): Promise<void> => {
  const index = args.firstIndex + args.stepNumber;
  try {
    await writeTraceSteps({
      target: args.target,
      firstIndex: index,
      steps: [args.step],
    });
  } catch (error) {
    log(
      'writeTraceStep: failed %s#%d %o',
      args.target.generationId,
      index,
      loggableError(error)
    );
  }
};

/**
 * Makes `steps` the generation's steps from `firstIndex` on: written in place,
 * and every object past them deleted. An empty `steps` discards an attempt.
 */
export const replaceTraceSteps = async (args: {
  target: TraceStepTarget;
  firstIndex: number;
  steps: unknown[];
}): Promise<void> => {
  const end = args.firstIndex + args.steps.length;
  await recordStepCount({
    target: args.target,
    next: () => {
      return end;
    },
  });
  await writeStepObjects(args);
  const stale = await findStepFiles({
    projectId: args.target.projectId,
    directory: generationDirectory(args.target),
  });
  await destroyStepFiles(
    stale.filter((file) => {
      return (parseStepPath(file.path)?.index ?? -1) >= end;
    })
  );
};

/** Steps by index. */
export type StoredSteps = Map<number, unknown>;

const readStep = async (file: StepFile): Promise<unknown> => {
  const buffer = await readFileBuffer({
    storagePath: file.storagePath,
    storageType: file.storageType,
  });
  if (!buffer) return undefined;
  try {
    const parsed: unknown = JSON.parse(buffer.toString('utf8'));
    return parsed;
  } catch {
    log('readStep: unparseable step object %s', file.path);
    return undefined;
  }
};

/** One generation's stored steps. */
export const readStoredGenerationSteps = async (args: {
  projectId: number;
  traceId: string;
  generationId: string;
}): Promise<StoredSteps> => {
  const files = await findStepFiles({
    projectId: args.projectId,
    directory: systemPath({
      module: 'traces',
      leaf: `${args.traceId}/${args.generationId}`,
    }),
  });
  const steps: StoredSteps = new Map();
  for (const file of files) {
    const located = parseStepPath(file.path);
    if (!located) continue;
    const step = await readStep(file);
    if (step !== undefined) steps.set(located.index, step);
  }
  return steps;
};

/** A generation's steps in index order: its legacy slice, overlaid by the
 * step objects, which own every index they hold. */
export const mergeSteps = (args: {
  legacy: unknown[];
  stored: StoredSteps;
}): unknown[] => {
  const merged = new Map<number, unknown>(args.legacy.entries());
  for (const [index, step] of args.stored) merged.set(index, step);
  return [...merged.entries()]
    .sort(([left], [right]) => {
      return left - right;
    })
    .map(([, step]) => {
      return step;
    });
};
