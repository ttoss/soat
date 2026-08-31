/**
 * Reading a generation back as a **replayable turn** — what it was asked, and
 * what it answered — rather than as the observability skeleton
 * `generations.ts` maps.
 *
 * The two halves live in different places, which is the whole reason this module
 * exists. The input is a generation column (`inputMessages`); the answer is in
 * the trace's steps object, which is a File. Callers that want to replay a turn
 * (curating a dataset item today; session forking and transcripts next) should
 * not each have to know that, and the evaluations module in particular must not
 * learn the trace file layout.
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
  /** The turn's final assistant text, or null when the steps object is gone. */
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
 * and agent it belongs to, and the trace carrying its steps file.
 *
 * Shared so the two consumers resolve a generation the same way and only one
 * of them has to know that the answer lives in a File hanging off the trace.
 * Throws `GENERATION_NOT_FOUND` when the id is unknown or out of scope.
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

/** Reads and parses a trace's steps object. Null when it cannot be read. */
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
 * Reads one generation's own steps out of its trace's steps object.
 *
 * A `trace_id` may group several generations, and the object then holds every
 * one of their segments — so a turn reader must take its own slice or it would
 * report a neighbouring turn's steps as this one's (#1024). A trace written
 * before the index existed holds a single turn and is read whole, which is what
 * every reader did before grouping worked.
 */
export const readGenerationSteps = async (
  generation: GenerationWithTrace
): Promise<unknown> => {
  return sliceGenerationSteps({
    steps: await readTraceSteps(generation.trace?.file),
    segments: generation.trace?.stepSegments,
    generationId: generation.publicId,
  });
};

/** How many steps of the trace's object are this generation's. Falls back to
 * the trace's own counter for an unindexed trace, whose object is one turn. */
export const generationStepCount = (
  generation: GenerationWithTrace
): number => {
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
 *   cleared it; replay needs exactly the content those policies withhold
 *   (#1003). Checked on `inputMessages`, not `contentRedactedAt`, so a
 *   generation predating the column reads the same way.
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

  const steps = await readGenerationSteps(generation);

  return {
    generationDbId: generation.id as number,
    projectDbId: generation.projectId,
    generationPublicId: generation.publicId,
    projectPublicId: generation.project.publicId,
    agentPublicId: generation.agent.publicId,
    agentVersion: generation.agentVersion,
    inputMessages,
    outputText: deriveTurnOutputText(steps),
  };
};
