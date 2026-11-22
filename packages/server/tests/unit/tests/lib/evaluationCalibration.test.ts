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
      });
      const b = scorerFingerprint({
        scorers: [
          {
            nested: { a: 2, b: 1 },
            pass_threshold: 0.8,
            prompt: 'Rate {{output}}',
            type: 'llm_judge',
          },
          { decider_id: 'dcd_1', name: 'review', type: 'decider' },
        ],
        deciderVersions: { other: 1, review: 2 },
      });
      expect(a).toBe(b);
      expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    test('moves with any scorer field and with a pinned decider version', () => {
      const base = scorerFingerprint({
        scorers: [JUDGE, DECIDER],
        deciderVersions: { review: 1 },
      });
      const changed = [
        scorerFingerprint({
          scorers: [{ ...JUDGE, prompt: 'Grade {{output}}' }, DECIDER],
          deciderVersions: { review: 1 },
        }),
        scorerFingerprint({
          scorers: [{ ...JUDGE, pass_threshold: 0.7 }, DECIDER],
          deciderVersions: { review: 1 },
        }),
        scorerFingerprint({
          scorers: [JUDGE, DECIDER],
          deciderVersions: { review: 2 },
        }),
      ];
      expect(new Set([base, ...changed]).size).toBe(4);
    });

    test('a run with no pinned decider reads as no versions', () => {
      expect(
        scorerFingerprint({ scorers: [JUDGE], deciderVersions: null })
      ).toBe(scorerFingerprint({ scorers: [JUDGE], deciderVersions: {} }));
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
    const tally = (labeled: number, agreement: number | null) => {
      return {
        scorers: {
          llm_judge: { labeled, agreement, false_pass: 0, false_fail: 0 },
        },
        labeled_count: labeled,
      };
    };
    const rule = { labeled: 30, agreement: 0.9 };

    test('one run reaching both figures supports it', () => {
      expect(
        calibrationReasons({
          rule,
          keys: ['llm_judge'],
          runs: [tally(10, 1), tally(30, 0.93)],
        })
      ).toEqual([
        {
          scope: { kind: 'calibration', name: 'llm_judge' },
          verdict: 'supported',
          reason: 'agreement 0.93 at or above 0.9',
        },
      ]);
    });

    test('enough labels below the agreement name the best agreement', () => {
      expect(
        calibrationReasons({
          rule,
          keys: ['llm_judge'],
          runs: [tally(30, 0.8), tally(40, 0.85)],
        })[0]
      ).toMatchObject({
        verdict: 'insufficient',
        reason: 'agreement 0.85 below 0.9',
      });
    });

    test('too few labels name the most any run has', () => {
      expect(
        calibrationReasons({
          rule,
          keys: ['llm_judge'],
          runs: [tally(12, 1), tally(20, 0.95)],
        })[0]
      ).toMatchObject({
        verdict: 'insufficient',
        reason: '20 labeled, 30 required',
      });
      expect(
        calibrationReasons({ rule, keys: ['llm_judge'], runs: [] })[0]
      ).toMatchObject({ reason: '0 labeled, 30 required' });
    });
  });
});
