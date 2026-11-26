import {
  calibrationOf,
  calibrationReasons,
  scorerFingerprint,
} from 'src/lib/evaluationCalibration';

/**
 * Calibration (the evaluations module doc — Human labels and calibration):
 * pure functions over rows the label reads already hold, so every boundary is
 * tested here rather than by seeding runs per case. Their wiring into the
 * routes and the claims read is `rest/evaluationLabels.test.ts` and
 * `rest/agentPromotionCalibration.test.ts`.
 */

const JUDGE = {
  type: 'llm_judge',
  name: 'llm_judge',
  prompt: 'Rate {{output}}',
  pass_threshold: 0.8,
};
const DECIDER = { type: 'decider', name: 'review', decider_id: 'dcd_1' };

describe('evaluationCalibration', () => {
  describe('scorerFingerprint', () => {
    test('ignores key order at every depth, in the scorers and the decider versions', () => {
      const a = scorerFingerprint({
        scorers: [{ ...JUDGE, nested: { b: 1, a: 2 } }, DECIDER],
        deciderVersions: { review: 2, other: 1 },
        scorerModels: null,
      });
      const b = scorerFingerprint({
        scorers: [
          {
            nested: { a: 2, b: 1 },
            pass_threshold: 0.8,
            prompt: 'Rate {{output}}',
            name: 'llm_judge',
            type: 'llm_judge',
          },
          { decider_id: 'dcd_1', name: 'review', type: 'decider' },
        ],
        deciderVersions: { other: 1, review: 2 },
        scorerModels: null,
      });
      expect(a).toBe(b);
      expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    test('keys a scorer by its name, outside its configuration', () => {
      // Pinned: the `name := type` backfill must leave the digest, and so
      // the labels counting against it, in place.
      expect(
        scorerFingerprint({
          scorers: [JUDGE],
          deciderVersions: null,
          scorerModels: null,
        })
      ).toBe(
        'sha256:44098a7f1eaabe9d65653d0798b4d30c1af54035ace5cb47d6dc95d01a91c5ec'
      );
    });

    test('refuses a scorer without a name', () => {
      const { name: _name, ...unnamed } = JUDGE;
      expect(() => {
        return scorerFingerprint({
          scorers: [unnamed],
          deciderVersions: null,
          scorerModels: null,
        });
      }).toThrow('scorer has no name');
    });

    test('swapping the names of two scorers moves it', () => {
      const a = { type: 'contains', value: 'refund' };
      const b = { type: 'contains', value: 'policy' };
      expect(
        scorerFingerprint({
          scorers: [
            { ...a, name: 'first' },
            { ...b, name: 'second' },
          ],
          deciderVersions: null,
          scorerModels: null,
        })
      ).not.toBe(
        scorerFingerprint({
          scorers: [
            { ...a, name: 'second' },
            { ...b, name: 'first' },
          ],
          deciderVersions: null,
          scorerModels: null,
        })
      );
    });

    test('moves with any scorer field and with a pinned decider version', () => {
      const base = scorerFingerprint({
        scorers: [JUDGE, DECIDER],
        deciderVersions: { review: 1 },
        scorerModels: null,
      });
      const changed = [
        scorerFingerprint({
          scorers: [{ ...JUDGE, prompt: 'Grade {{output}}' }, DECIDER],
          deciderVersions: { review: 1 },
          scorerModels: null,
        }),
        scorerFingerprint({
          scorers: [{ ...JUDGE, pass_threshold: 0.7 }, DECIDER],
          deciderVersions: { review: 1 },
          scorerModels: null,
        }),
        scorerFingerprint({
          scorers: [JUDGE, DECIDER],
          deciderVersions: { review: 2 },
          scorerModels: null,
        }),
      ];
      expect(new Set([base, ...changed]).size).toBe(4);
    });

    test('moves with the model a judge pinned', () => {
      const pinned = (routeId: string) => {
        return scorerFingerprint({
          scorers: [JUDGE],
          deciderVersions: null,
          scorerModels: { llm_judge: { model_route_id: routeId } },
        });
      };
      expect(pinned('route_a')).toBe(pinned('route_a'));
      expect(pinned('route_a')).not.toBe(pinned('route_b'));
    });

    test('a run with no pinned decider reads as no versions', () => {
      expect(
        scorerFingerprint({
          scorers: [JUDGE],
          deciderVersions: null,
          scorerModels: null,
        })
      ).toBe(
        scorerFingerprint({
          scorers: [JUDGE],
          deciderVersions: {},
          scorerModels: null,
        })
      );
    });
  });

  describe('calibrationOf', () => {
    test('counts each side apart and skips what a scorer did not grade', () => {
      const report = calibrationOf({
        scorers: [JUDGE, DECIDER],
        labeled: [
          {
            humanPassed: true,
            scores: [
              { scorer: 'llm_judge', passed: false },
              { scorer: 'review', passed: true },
            ],
          },
          {
            humanPassed: false,
            scores: [
              { scorer: 'llm_judge', passed: false },
              { scorer: 'review', passed: true },
              { scorer: 'ghost', passed: true },
            ],
          },
          {
            humanPassed: true,
            scores: [{ scorer: 'llm_judge', passed: null }],
          },
          { humanPassed: false, scores: null },
        ],
      });
      expect(report).toEqual({
        labeled_count: 4,
        scorers: {
          llm_judge: {
            labeled: 2,
            agreement: 0.5,
            false_pass: 0,
            false_fail: 1,
          },
          review: { labeled: 2, agreement: 0.5, false_pass: 1, false_fail: 0 },
        },
      });
    });

    test('a scorer with nothing labeled has no agreement', () => {
      expect(calibrationOf({ scorers: [JUDGE], labeled: [] })).toEqual({
        labeled_count: 0,
        scorers: {
          llm_judge: {
            labeled: 0,
            agreement: null,
            false_pass: 0,
            false_fail: 0,
          },
        },
      });
    });
  });

  describe('calibrationReasons', () => {
    const tally = (labeled: number, disagreed: number) => {
      return {
        scorers: {
          llm_judge: {
            labeled,
            agreement: labeled === 0 ? null : (labeled - disagreed) / labeled,
            false_pass: disagreed,
            false_fail: 0,
          },
        },
        labeled_count: labeled,
      };
    };
    const rule = { labeled: 30, agreement: 0.9 };

    test('labels across runs graded by the same scorers add up', () => {
      expect(
        calibrationReasons({
          rule,
          keys: ['llm_judge'],
          runs: [tally(10, 0), tally(20, 1)],
        })
      ).toEqual([
        {
          scope: { kind: 'calibration', name: 'llm_judge' },
          verdict: 'supported',
          reason: 'agreement 0.967 at or above 0.9',
        },
      ]);
    });

    test('the pooled agreement decides, not the best run', () => {
      expect(
        calibrationReasons({
          rule,
          keys: ['llm_judge'],
          runs: [tally(30, 1), tally(30, 15)],
        })[0]
      ).toMatchObject({
        verdict: 'insufficient',
        reason: 'agreement 0.733 below 0.9',
      });
    });

    test('too few labels name the pooled count', () => {
      expect(
        calibrationReasons({
          rule,
          keys: ['llm_judge'],
          runs: [tally(12, 0), tally(10, 0)],
        })[0]
      ).toMatchObject({
        verdict: 'insufficient',
        reason: '22 labeled, 30 required',
      });
      expect(
        calibrationReasons({ rule, keys: ['llm_judge'], runs: [] })[0]
      ).toMatchObject({ reason: '0 labeled, 30 required' });
    });
  });
});
