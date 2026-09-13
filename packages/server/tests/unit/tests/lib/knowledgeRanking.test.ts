import {
  DEFAULT_RRF_K,
  fuseByReciprocalRank,
  resolveRrfK,
} from 'src/lib/knowledgeRanking';

type Item = { id: string };

const item = (id: string): Item => {
  return { id };
};

const keyOf = (value: Item): string => {
  return value.id;
};

describe('fuseByReciprocalRank', () => {
  test('scores a single list as 1 / (k + rank)', () => {
    const fused = fuseByReciprocalRank({
      lists: [[item('a'), item('b')]],
      keyOf,
      k: 60,
    });

    expect(
      fused.map((entry) => {
        return entry.item.id;
      })
    ).toEqual(['a', 'b']);
    expect(fused[0].score).toBeCloseTo(1 / 61, 10);
    expect(fused[1].score).toBeCloseTo(1 / 62, 10);
  });

  test('sums the reciprocal ranks a result earns across lists', () => {
    const fused = fuseByReciprocalRank({
      lists: [
        [item('a'), item('b')],
        [item('b'), item('c')],
      ],
      keyOf,
      k: 60,
    });

    expect(
      fused.map((entry) => {
        return entry.item.id;
      })
    ).toEqual(['b', 'a', 'c']);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(fused[1].score).toBeCloseTo(1 / 61, 10);
    expect(fused[2].score).toBeCloseTo(1 / 62, 10);
  });

  test('a result in two lists outranks a result in one at the same best rank', () => {
    const fused = fuseByReciprocalRank({
      lists: [[item('only-vector'), item('both')], [item('both')]],
      keyOf,
      k: 60,
    });

    // `both` is second in the first list, so a raw-score interleave would put
    // `only-vector` first; appearing in two lists is what overturns that.
    expect(fused[0].item.id).toBe('both');
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  test('fuses up to four lists, keying on identity across sources', () => {
    const fused = fuseByReciprocalRank({
      lists: [
        [item('doc-1')],
        [item('doc-1'), item('doc-2')],
        [item('mem-1')],
        [item('mem-1'), item('mem-2')],
      ],
      keyOf,
      k: 60,
    });

    expect(fused).toHaveLength(4);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 61, 10);
    expect(
      fused
        .map((entry) => {
          return entry.item.id;
        })
        .slice(0, 2)
    ).toEqual(['doc-1', 'mem-1']);
  });

  test('a smaller k widens the gap between adjacent ranks', () => {
    const tight = fuseByReciprocalRank({
      lists: [[item('a'), item('b')]],
      keyOf,
      k: 1,
    });
    const loose = fuseByReciprocalRank({
      lists: [[item('a'), item('b')]],
      keyOf,
      k: 60,
    });

    expect(tight[0].score - tight[1].score).toBeGreaterThan(
      loose[0].score - loose[1].score
    );
  });

  test('keeps the first-seen representative of a result', () => {
    const first = { id: 'a', from: 'vector' };
    const second = { id: 'a', from: 'lexical' };
    const fused = fuseByReciprocalRank({
      lists: [[first], [second]],
      keyOf: (value: { id: string }) => {
        return value.id;
      },
      k: 60,
    });

    expect(fused).toHaveLength(1);
    expect(fused[0].item).toBe(first);
  });

  test('drops empty lists without shifting the ranks of the others', () => {
    const fused = fuseByReciprocalRank({
      lists: [[], [item('a')], []],
      keyOf,
      k: 60,
    });

    expect(fused).toHaveLength(1);
    expect(fused[0].score).toBeCloseTo(1 / 61, 10);
  });

  test('returns an empty result for no lists at all', () => {
    expect(fuseByReciprocalRank({ lists: [], keyOf, k: 60 })).toEqual([]);
  });
});

describe('resolveRrfK', () => {
  const original = process.env.KNOWLEDGE_RRF_K;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.KNOWLEDGE_RRF_K;
    } else {
      process.env.KNOWLEDGE_RRF_K = original;
    }
  });

  test('defaults to 60', () => {
    delete process.env.KNOWLEDGE_RRF_K;
    expect(resolveRrfK()).toBe(DEFAULT_RRF_K);
    expect(DEFAULT_RRF_K).toBe(60);
  });

  test('prefers the request value over the deployment default', () => {
    process.env.KNOWLEDGE_RRF_K = '10';
    expect(resolveRrfK(5)).toBe(5);
  });

  test('falls back to KNOWLEDGE_RRF_K when the request names none', () => {
    process.env.KNOWLEDGE_RRF_K = '10';
    expect(resolveRrfK()).toBe(10);
  });

  test('ignores a non-numeric or out-of-range deployment default', () => {
    process.env.KNOWLEDGE_RRF_K = 'sixty';
    expect(resolveRrfK()).toBe(DEFAULT_RRF_K);
    process.env.KNOWLEDGE_RRF_K = '0';
    expect(resolveRrfK()).toBe(DEFAULT_RRF_K);
  });

  test('floors a fractional value and falls back below the minimum', () => {
    delete process.env.KNOWLEDGE_RRF_K;
    expect(resolveRrfK(7.9)).toBe(7);
    expect(resolveRrfK(0)).toBe(DEFAULT_RRF_K);
    expect(resolveRrfK(Number.NaN)).toBe(DEFAULT_RRF_K);
  });
});
