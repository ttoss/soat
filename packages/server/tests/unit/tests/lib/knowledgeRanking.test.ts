import {
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
  DEFAULT_RRF_K,
  fuseByReciprocalRank,
  recencyDecayFactor,
  resolveRecencyHalfLifeDays,
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

describe('resolveRecencyHalfLifeDays', () => {
  const original = process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;
    } else {
      process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = original;
    }
  });

  test('defaults to 0, which disables the blend', () => {
    delete process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;
    expect(resolveRecencyHalfLifeDays()).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS);
    expect(DEFAULT_RECENCY_HALF_LIFE_DAYS).toBe(0);
  });

  test('prefers the request value over the deployment default', () => {
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';
    expect(resolveRecencyHalfLifeDays(7)).toBe(7);
  });

  test('falls back to KNOWLEDGE_RECENCY_HALF_LIFE_DAYS when the request names none', () => {
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';
    expect(resolveRecencyHalfLifeDays()).toBe(30);
  });

  test('lets a request 0 turn a deployment-wide blend off', () => {
    // The archival query on a deployment that otherwise wants decay.
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';
    expect(resolveRecencyHalfLifeDays(0)).toBe(0);
  });

  test('keeps a sub-day half-life reachable', () => {
    delete process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;
    expect(resolveRecencyHalfLifeDays(0.5)).toBe(0.5);
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '0.5';
    expect(resolveRecencyHalfLifeDays()).toBe(0.5);
  });

  test('ignores a non-numeric or negative deployment default', () => {
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = 'thirty';
    expect(resolveRecencyHalfLifeDays()).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS);
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '-1';
    expect(resolveRecencyHalfLifeDays()).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS);
  });

  test('falls back rather than throwing on an invalid request value', () => {
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';
    expect(resolveRecencyHalfLifeDays(-1)).toBe(30);
    expect(resolveRecencyHalfLifeDays(Number.NaN)).toBe(30);
    expect(resolveRecencyHalfLifeDays(Number.POSITIVE_INFINITY)).toBe(30);
  });
});

describe('recencyDecayFactor', () => {
  const now = Date.parse('2026-09-13T00:00:00Z');
  const daysAgo = (days: number): Date => {
    return new Date(now - days * 86400000);
  };

  test('halves the factor once per half-life', () => {
    const factor = (days: number): number => {
      return recencyDecayFactor({
        updatedAt: daysAgo(days),
        now,
        halfLifeDays: 30,
      });
    };

    expect(factor(0)).toBe(1);
    expect(factor(30)).toBeCloseTo(0.5, 10);
    expect(factor(60)).toBeCloseTo(0.25, 10);
    expect(factor(1)).toBeCloseTo(2 ** (-1 / 30), 12);
  });

  test('leaves every result untouched at a half-life of 0', () => {
    expect(
      recencyDecayFactor({
        updatedAt: daysAgo(3650),
        now,
        halfLifeDays: 0,
      })
    ).toBe(1);
  });

  test('never promotes a result whose timestamp is in the future', () => {
    // Clock skew between the writer and the reader is not freshness evidence.
    expect(
      recencyDecayFactor({
        updatedAt: daysAgo(-30),
        now,
        halfLifeDays: 30,
      })
    ).toBe(1);
  });
});
