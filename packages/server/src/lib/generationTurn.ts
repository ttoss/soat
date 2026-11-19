/**
 * Reading a generation back as a **replayable turn** — what it was asked, and
 * what it answered — rather than as the observability skeleton
 * `generations.ts` maps.
 *
 * The two halves live in different places, which is the whole reason this module
 * exists. The input is a generation column (`inputMessages`); the answer is in
 * the trace's step objects (`traceStepStore.ts`). Callers that want to replay a
 * turn (curating a dataset item, forking a session, reading a transcript)
 * should not each have to know that, and the evaluations module in particular
 * must not learn the trace file layout.
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { readFileBuffer } from './fileStorage';
import { isPlainObject } from './plainObject';
import { makeResourceAccessor } from './resourceAccessor';
import {
  locateSegment,
  readStepSegments,
  sliceGenerationSteps,
} from './traceStepSegments';
import { mergeSteps, readStoredGenerationSteps } from './traceStepStore';

const log = createDebug('soat:generation-turn');

type GenerationRow = InstanceType<(typeof db)['Generation']> & {
  project?: InstanceType<(typeof db)['Project']>;
  agent?: InstanceType<(typeof db)['Agent']>;
  trace?:
    | (InstanceType<(typeof db)['Trace']> & {
        file?: InstanceType<(typeof db)['File']> | null;
      })
    | null;
};

export type GenerationWithTrace = GenerationRow;

const generations = makeResourceAccessor<GenerationRow>({
  model: () => {
    return db.Generation;
  },
  includes: () => {
    return [
      { model: db.Project, as: 'project' },
      { model: db.Agent, as: 'agent' },
      {
        model: db.Trace,
        as: 'trace',
        include: [{ model: db.File, as: 'file' }],
      },
    ];
  },
  label: 'Generation',
  errorCode: 'GENERATION_NOT_FOUND',
});

export type GenerationTurn = {
  /** Internal ids, for callers that link a row back to the generation. */
  generationDbId: number;
  projectDbId: number;
  generationPublicId: string;
  projectPublicId: string;
  agentPublicId: string;
  agentVersion: number | null;
  /** The turn's resolved input, message-shaped and ready to replay. */
  inputMessages: unknown[];
  /** The turn's final assistant text, or null when its steps are gone. */
  outputText: string | null;
};

/**
 * The text parts of one serialized step, joined.
 *
 * A stored step has no `text` field even though the AI SDK's live `StepResult`
 * exposes one: that property is a getter over `content`, and `serializeSteps`
 * goes through `JSON.stringify`, which copies own enumerable properties only.
 * The `content` array is what actually survives to disk, so it is what this
 * reads — a derivation off `step.text` silently yields null for every turn.
 */
const stepText = (step: Record<string, unknown>): string => {
  if (!Array.isArray(step.content)) return '';

  return step.content
    .filter((part): part is { type: string; text: string } => {
      return (
        isPlainObject(part) &&
        part.type === 'text' &&
        typeof part.text === 'string'
      );
    })
    .map((part) => {
      return part.text;
    })
    .join('');
};

/**
 * The final assistant text of a run, from its serialized steps.
 *
 * Scans backwards for the last step carrying non-empty text rather than reading
 * `steps.at(-1)` blindly: a run whose last step is a tool call (a `max_steps`
 * cutoff, a stop condition firing after a tool result) has no text of its own,
 * and the answer worth keeping is the one before it. Returns null when no step
 * produced text at all — a turn that only called tools has no reference answer,
 * which is a legitimate thing for a caller to supply by hand.
 */
export const deriveTurnOutputText = (steps: unknown): string | null => {
  if (!Array.isArray(steps)) return null;

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!isPlainObject(step)) continue;
    const text = stepText(step);
    if (text.trim() !== '') return text;
  }

  return null;
};

/**
 * Loads a generation with the associations both turn readers need: the project
 * and agent it belongs to, and the trace carrying its steps.
 *
 * Shared so the two consumers resolve a generation the same way. Throws
 * `GENERATION_NOT_FOUND` when the id is unknown or out of scope.
 */
export const loadGenerationWithTrace = async (args: {
  generationId: string;
  projectIds?: number[];
}): Promise<GenerationWithTrace> => {
  return generations.getByPublicId({
    id: args.generationId,
    projectIds: args.projectIds,
  });
};

/** Reads and parses a trace's legacy steps object. Null when it cannot be read. */
export const readTraceSteps = async (
  file: { storagePath: string; storageType: string } | null | undefined
): Promise<unknown> => {
  if (!file) return null;

  const buffer = await readFileBuffer({
    storagePath: file.storagePath,
    storageType: file.storageType,
  });
  if (!buffer) return null;

  try {
    // Annotated rather than cast: `JSON.parse` is typed `any`, and widening it
    // to `unknown` at the binding forces every reader below through a guard.
    const parsed: unknown = JSON.parse(buffer.toString('utf8'));
    return parsed;
  } catch {
    // A steps object that is not JSON is corrupt, not fatal: the caller loses
    // the derived reference answer and can still supply one.
    log(
      'readTraceSteps: steps object at %s is not valid JSON',
      file.storagePath
    );
    return null;
  }
};

/**
 * A generation's slice of its trace's legacy steps object. Only a generation
 * with no `stepCount` of its own has one; a trace without the segment index
 * holds a single turn and is read whole.
 */
const readLegacyGenerationSteps = async (
  generation: GenerationWithTrace
): Promise<unknown[]> => {
  if (generation.stepCount !== null || !generation.trace?.file) return [];
  return sliceGenerationSteps({
    steps: await readTraceSteps(generation.trace.file),
    segments: generation.trace.stepSegments,
    generationId: generation.publicId,
  });
};

/**
 * One generation's own steps, in order: its step objects over any legacy
 * slice. Never another generation's, though a `trace_id` may group several.
 */
export const readGenerationSteps = async (
  generation: GenerationWithTrace
): Promise<unknown[]> => {
  if (!generation.trace) return [];
  const [legacy, stored] = await Promise.all([
    readLegacyGenerationSteps(generation),
    readStoredGenerationSteps({
      projectId: generation.trace.projectId,
      traceId: generation.trace.publicId,
      generationId: generation.publicId,
    }),
  ]);
  return mergeSteps({ legacy, stored });
};

/**
 * The final assistant text of a `completed` generation; null for any other
 * status, whose steps (a running or paused turn's) are no answer.
 */
export const completedTurnOutputText = async (
  generation: GenerationWithTrace
): Promise<string | null> => {
  if (generation.status !== 'completed') return null;
  return deriveTurnOutputText(await readGenerationSteps(generation));
};

/** How many steps are this generation's: its own counter, else its segment of
 * the legacy object, else the trace's counter for an unindexed trace. */
export const generationStepCount = (
  generation: GenerationWithTrace
): number => {
  if (generation.stepCount !== null) return generation.stepCount;
  const segments = readStepSegments(generation.trace?.stepSegments);
  if (segments.length === 0) return generation.trace?.stepCount ?? 0;

  return locateSegment(segments, generation.publicId).stepCount;
};

/**
 * Loads a completed generation as a replayable turn.
 *
 * Refuses two states rather than degrading, because both would produce a
 * silently useless fixture:
 *
 * - **Not completed** — a paused or failed turn has no finished answer, so an
 *   item built from it would score whatever the agent does next.
 * - **Content unavailable** — zero-retention never wrote the input, or a purge
 *   cleared it; replay needs exactly the content those policies withhold.
 *   Checked on `inputMessages`, not `contentRedactedAt`, so a generation
 *   carrying no value in that column reads the same way.
 */
export const getGenerationTurn = async (args: {
  generationId: string;
  projectIds?: number[];
}): Promise<GenerationTurn> => {
  log('getGenerationTurn: generationId=%s', args.generationId);

  const generation = await loadGenerationWithTrace({
    generationId: args.generationId,
    projectIds: args.projectIds,
  });

  if (generation.status !== 'completed') {
    throw new DomainError(
      'GENERATION_NOT_COMPLETED',
      `Generation '${args.generationId}' has status '${generation.status}'; only a completed generation can be replayed.`
    );
  }

  const inputMessages = generation.inputMessages;
  if (!Array.isArray(inputMessages) || inputMessages.length === 0) {
    throw new DomainError(
      'GENERATION_CONTENT_UNAVAILABLE',
      `Generation '${args.generationId}' has no stored input: its content was never retained, or has been purged.`
    );
  }

  /* istanbul ignore next -- both are non-null FKs, so neither association can be
     missing; the guard exists to narrow the types below. */
  if (!generation.project || !generation.agent) {
    throw new DomainError(
      'GENERATION_NOT_FOUND',
      `Generation '${args.generationId}' is missing its project or agent.`
    );
  }

  return {
    generationDbId: generation.id as number,
    projectDbId: generation.projectId,
    generationPublicId: generation.publicId,
    projectPublicId: generation.project.publicId,
    agentPublicId: generation.agent.publicId,
    agentVersion: generation.agentVersion,
    inputMessages,
    outputText: await completedTurnOutputText(generation),
  };
};
