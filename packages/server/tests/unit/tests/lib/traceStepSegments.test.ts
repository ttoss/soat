import {
  applySegment,
  locateSegment,
  readStepSegments,
  totalSegmentSteps,
} from 'src/lib/traceStepSegments';

/**
 * The index that divides a trace's steps object between grouped generations
 * (#1024).
 *
 * Tested directly (keep-list rule 1): it is a pure algorithm whose input space
 * — how many generations, in what order, which one is rewriting, whether the
 * trace is indexed at all — costs a full agent run per case through REST, and
 * whose failure signal there is a step count that looks plausible. The write
 * and read paths that use it are pinned end-to-end in `lib/agentTraces.test.ts`
 * and `rest/generationTranscript.test.ts`; `sliceGenerationSteps`, the read side
 * of the same index, is covered in `lib/generationTranscript.test.ts`.
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

describe('applySegment', () => {
  test('appends a generation writing for the first time', () => {
    expect(
      applySegment({
        segments: [{ generationId: 'gen_a', stepCount: 2 }],
        generationId: 'gen_b',
        stepCount: 1,
      })
    ).toEqual([
      { generationId: 'gen_a', stepCount: 2 },
      { generationId: 'gen_b', stepCount: 1 },
    ]);
  });

  test('rewrites a generation in place, keeping its position', () => {
    // The tool-outputs continuation: gen_a writes again, longer, and must not
    // move behind gen_b.
    expect(
      applySegment({
        segments: [
          { generationId: 'gen_a', stepCount: 1 },
          { generationId: 'gen_b', stepCount: 1 },
        ],
        generationId: 'gen_a',
        stepCount: 4,
      })
    ).toEqual([
      { generationId: 'gen_a', stepCount: 4 },
      { generationId: 'gen_b', stepCount: 1 },
    ]);
  });
});

describe('totalSegmentSteps', () => {
  test('sums every generation grouped under the trace', () => {
    expect(
      totalSegmentSteps([
        { generationId: 'gen_a', stepCount: 2 },
        { generationId: 'gen_b', stepCount: 3 },
      ])
    ).toBe(5);
    expect(totalSegmentSteps([])).toBe(0);
  });
});
