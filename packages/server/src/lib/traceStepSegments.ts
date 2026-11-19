/**
 * The index that divides a trace's legacy steps object (`Trace.fileId`)
 * between the generations grouped under it (`Trace.stepSegments`). Read-only:
 * a step is written as its own object (`traceStepStore.ts`).
 *
 * The object is the concatenation of one segment per generation, in the order
 * they first wrote.
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
 * segment gets the end of the object and a length of zero.
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

/**
 * The steps belonging to one generation, out of a trace's whole steps object.
 *
 * An **unindexed** object is returned whole: it carries one generation's steps
 * and nothing else, so there is no segment to take.
 *
 * An indexed object with no segment for this generation yields nothing: the
 * generation recorded nothing there, and returning the tail would attribute
 * another turn's steps to it.
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
