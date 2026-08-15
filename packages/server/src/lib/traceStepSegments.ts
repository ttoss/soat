/**
 * The index that divides a trace's steps object between the generations
 * grouped under it (`Trace.stepSegments`).
 *
 * A `trace_id` may be reused to group several generations, so the object is the
 * concatenation of one segment per generation, in the order they first wrote.
 * Both sides of that layout live here: `traceWrite` places a write inside it,
 * and `generationTurn` reads one generation's slice back out. Splitting them
 * across two modules is how the object and the index drift apart (#1024).
 */
import createDebug from 'debug';

import { isPlainObject } from './plainObject';

const log = createDebug('soat:traces');

/** One generation's slice of a trace's steps object. */
export type StepSegment = { generationId: string; stepCount: number };

const isStepSegment = (value: unknown): value is StepSegment => {
  return (
    isPlainObject(value) &&
    typeof value.generationId === 'string' &&
    typeof value.stepCount === 'number'
  );
};

/** The index off a Trace row, guarded — the column is JSONB, so its shape is
 * runtime data rather than something the model type can promise. */
export const readStepSegments = (segments: unknown): StepSegment[] => {
  if (!Array.isArray(segments)) return [];
  return segments.filter(isStepSegment);
};

/**
 * Where `generationId`'s slice starts and how long it is. A generation with no
 * segment yet gets the end of the object and a length of zero, so a first write
 * appends.
 */
export const locateSegment = (
  segments: StepSegment[],
  generationId: string
): { offset: number; stepCount: number; found: boolean } => {
  let offset = 0;
  for (const segment of segments) {
    if (segment.generationId === generationId) {
      return { offset, stepCount: segment.stepCount, found: true };
    }
    offset += segment.stepCount;
  }
  return { offset, stepCount: 0, found: false };
};

/** The index with `generationId`'s segment set to `stepCount` — replaced in
 * place when it already has one, appended when it does not. */
export const applySegment = (args: {
  segments: StepSegment[];
  generationId: string;
  stepCount: number;
}): StepSegment[] => {
  const { found } = locateSegment(args.segments, args.generationId);

  if (!found) {
    return [
      ...args.segments,
      { generationId: args.generationId, stepCount: args.stepCount },
    ];
  }

  return args.segments.map((segment) => {
    return segment.generationId === args.generationId
      ? { generationId: segment.generationId, stepCount: args.stepCount }
      : segment;
  });
};

export const totalSegmentSteps = (segments: StepSegment[]): number => {
  return segments.reduce((sum, segment) => {
    return sum + segment.stepCount;
  }, 0);
};

/**
 * The steps belonging to one generation, out of a trace's whole steps object.
 *
 * An **unindexed** object — every trace written before the index existed — is
 * returned whole: its steps were one generation's, which is what a trace held
 * before grouping worked, so a turn reader keeps reading it exactly as it did.
 *
 * An indexed object with no segment for this generation yields nothing. Note
 * this is the opposite of what `locateSegment` alone would say: that answers
 * "where should this generation write next", so an absent generation gets the
 * end of the object. On the read side the same absence means the generation
 * recorded nothing — still running, or failed before writing — and returning
 * the tail would attribute another turn's steps to it.
 */
export const sliceGenerationSteps = (args: {
  steps: unknown;
  segments: unknown;
  generationId: string;
}): unknown[] => {
  // A missing or corrupt object is no steps at all, never a passthrough: every
  // caller projects or scans this, and a non-array would silently read as one.
  if (!Array.isArray(args.steps)) return [];

  const segments = readStepSegments(args.segments);
  if (segments.length === 0) return args.steps;

  const { offset, stepCount, found } = locateSegment(
    segments,
    args.generationId
  );
  if (!found) {
    log(
      'sliceGenerationSteps: generationId=%s absent from the segment index of an indexed trace',
      args.generationId
    );
    return [];
  }

  // Clamped by `slice`: the index and the object are written together but live
  // in separate stores, so a truncated object must not yield undefined entries.
  return args.steps.slice(offset, offset + stepCount);
};
