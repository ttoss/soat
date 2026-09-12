import {
  firstRelevantRank,
  meanReciprocalRank,
  recallAtK,
  roundMetric,
} from 'tests/eval/knowledge/metrics';

describe('knowledge eval metrics', () => {
  describe('firstRelevantRank', () => {
    test('returns the 1-based position of the first expected key', () => {
      expect(
        firstRelevantRank({ expected: ['c'], ranked: ['a', 'b', 'c', 'd'] })
      ).toBe(3);
    });

    test('returns 1 when the first result is relevant', () => {
      expect(firstRelevantRank({ expected: ['a'], ranked: ['a', 'b'] })).toBe(
        1
      );
    });

    test('returns null when no result is relevant', () => {
      expect(firstRelevantRank({ expected: ['z'], ranked: ['a', 'b'] })).toBe(
        null
      );
    });

    test('returns null for an empty result list', () => {
      expect(firstRelevantRank({ expected: ['a'], ranked: [] })).toBe(null);
    });

    test('takes the earliest position when several keys are expected', () => {
      expect(
        firstRelevantRank({
          expected: ['d', 'b'],
          ranked: ['a', 'b', 'c', 'd'],
        })
      ).toBe(2);
    });

    test('rejects an empty expected set', () => {
      expect(() => {
        return firstRelevantRank({ expected: [], ranked: ['a'] });
      }).toThrow(/expected/i);
    });
  });

  describe('recallAtK', () => {
    test('is the fraction of expected keys inside the first k results', () => {
      expect(
        recallAtK({
          expected: ['a', 'b', 'c', 'd'],
          ranked: ['a', 'x', 'b', 'y', 'z'],
          k: 5,
        })
      ).toBe(0.5);
    });

    test('counts only the first k positions', () => {
      expect(
        recallAtK({ expected: ['c'], ranked: ['a', 'b', 'c'], k: 2 })
      ).toBe(0);
      expect(
        recallAtK({ expected: ['c'], ranked: ['a', 'b', 'c'], k: 3 })
      ).toBe(1);
    });

    test('is 1 when every expected key is retrieved', () => {
      expect(
        recallAtK({ expected: ['a', 'b'], ranked: ['b', 'a'], k: 5 })
      ).toBe(1);
    });

    test('is 0 for an empty result list', () => {
      expect(recallAtK({ expected: ['a'], ranked: [], k: 5 })).toBe(0);
    });

    test('counts a repeated expected key once', () => {
      // A document occupying several slots is one hit, not many: recall must
      // stay a fraction of the distinct expected keys.
      expect(
        recallAtK({ expected: ['a', 'b'], ranked: ['a', 'a', 'a'], k: 5 })
      ).toBe(0.5);
    });

    test('deduplicates the expected set', () => {
      expect(
        recallAtK({ expected: ['a', 'a'], ranked: ['a', 'x'], k: 5 })
      ).toBe(1);
    });

    test('rejects an empty expected set', () => {
      expect(() => {
        return recallAtK({ expected: [], ranked: ['a'], k: 5 });
      }).toThrow(/expected/i);
    });

    test('rejects a non-positive k', () => {
      expect(() => {
        return recallAtK({ expected: ['a'], ranked: ['a'], k: 0 });
      }).toThrow(/k/i);
    });
  });

  describe('meanReciprocalRank', () => {
    test('averages the reciprocal of each first relevant rank', () => {
      expect(meanReciprocalRank({ ranks: [1, 2, 4] })).toBeCloseTo(
        (1 + 0.5 + 0.25) / 3,
        10
      );
    });

    test('scores a query with no relevant result as 0', () => {
      expect(meanReciprocalRank({ ranks: [1, null] })).toBe(0.5);
    });

    test('is 0 when no query has a relevant result', () => {
      expect(meanReciprocalRank({ ranks: [null, null] })).toBe(0);
    });

    test('is 0 for no queries at all', () => {
      expect(meanReciprocalRank({ ranks: [] })).toBe(0);
    });
  });

  describe('roundMetric', () => {
    test('rounds to four decimals so a report is byte-stable', () => {
      expect(roundMetric(1 / 3)).toBe(0.3333);
      expect(roundMetric(2 / 3)).toBe(0.6667);
    });

    test('leaves exact values alone', () => {
      expect(roundMetric(1)).toBe(1);
      expect(roundMetric(0)).toBe(0);
    });

    test('never returns negative zero', () => {
      // `-0` serializes as `-0` in JSON and would flip the byte-identical
      // report guarantee on a sign that means nothing here.
      expect(Object.is(roundMetric(-0), 0)).toBe(true);
    });
  });
});
