import { locateSegment, readStepSegments } from 'src/lib/traceStepSegments';

/**
 * The index that divides a trace's legacy steps object between grouped
 * generations.
 *
 * Tested directly (keep-list rule 1): it is a pure algorithm whose input space
 * — how many generations, in what order, which one is rewriting, whether the
 * trace is indexed at all — costs a full agent run per case through REST, and
 * whose failure signal there is a step count that looks plausible.
 * `sliceGenerationSteps`, the read side of the same index, is covered in
 * `lib/generationTranscript.test.ts`.
 */
describe('readStepSegments', () => {
  test('returns the index as stored', () => {
    const segments = [{ generationId: 'gen_a', stepCount: 2 }];
    expect(readStepSegments(segments)).toEqual(segments);
  });

  test('drops entries that are not segments, and non-array columns', () => {
    // The column is JSONB, so its shape is runtime data, not a model promise.
    expect(
      readStepSegments([
        { generationId: 'gen_a', stepCount: 2 },
        { generationId: 'gen_b' },
        { stepCount: 3 },
        'gen_c',
        null,
      ])
    ).toEqual([{ generationId: 'gen_a', stepCount: 2 }]);

    expect(readStepSegments(undefined)).toEqual([]);
    expect(readStepSegments({ gen_a: 2 })).toEqual([]);
  });
});

describe('locateSegment', () => {
  const segments = [
    { generationId: 'gen_a', stepCount: 2 },
    { generationId: 'gen_b', stepCount: 3 },
  ];

  test('offsets a segment by every segment before it', () => {
    expect(locateSegment(segments, 'gen_a')).toEqual({
      offset: 0,
      stepCount: 2,
      found: true,
    });
    expect(locateSegment(segments, 'gen_b')).toEqual({
      offset: 2,
      stepCount: 3,
      found: true,
    });
  });

  test('puts a generation that has not written yet at the end', () => {
    expect(locateSegment(segments, 'gen_c')).toEqual({
      offset: 5,
      stepCount: 0,
      found: false,
    });
  });
});
