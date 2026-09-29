import {
  exactMcNemarPValue,
  wilsonInterval,
} from 'src/lib/evaluationStatistics';

/**
 * The uncertainty figures on an eval run (the evaluations module doc —
 * Uncertainty).
 *
 * In `lib/` under the keep-list rule: both are closed-form statistics whose
 * input space is every count a run can produce, and each reference value here
 * would otherwise need a dataset of that size run twice through REST. The
 * wiring — that a run persists them under `aggregate_scores` — is covered in
 * `rest/evaluationsUncertainty.test.ts`. Reference values are computed
 * independently with exact binomial sums.
 */
describe('evaluation statistics', () => {
  describe('wilsonInterval', () => {
    test.each([
      [45, 60, 0.627679, 0.842235],
      [6, 12, 0.253782, 0.746218],
      [1, 4, 0.045587, 0.699358],
      [3, 5, 0.230724, 0.882379],
    ])('%d of %d → [%d, %d]', (passed, total, low, high) => {
      const interval = wilsonInterval({ passed, total });

      expect(interval?.low).toBeCloseTo(low, 6);
      expect(interval?.high).toBeCloseTo(high, 6);
      expect(interval?.level).toBe(0.95);
    });

    test('no pass reaches down to 0 without crossing it', () => {
      const interval = wilsonInterval({ passed: 0, total: 10 });

      expect(interval?.low).toBe(0);
      expect(interval?.high).toBeCloseTo(0.277533, 6);
    });

    test('every pass reaches up to 1 without crossing it', () => {
      const interval = wilsonInterval({ passed: 10, total: 10 });

      expect(interval?.low).toBeCloseTo(0.722467, 6);
      expect(interval?.high).toBe(1);
    });

    test('is null when nothing was scored', () => {
      expect(wilsonInterval({ passed: 0, total: 0 })).toBeNull();
    });

    test('narrows as the same pass rate is measured over more items', () => {
      const small = wilsonInterval({ passed: 6, total: 12 })!;
      const large = wilsonInterval({ passed: 60, total: 120 })!;

      expect(large.high - large.low).toBeLessThan(small.high - small.low);
    });
  });

  describe('exactMcNemarPValue', () => {
    test.each([
      [9, 6, 0.60723876953125],
      [0, 6, 0.03125],
      [9, 0, 0.00390625],
      [5, 2, 0.453125],
    ])('%d improved, %d regressed → %d', (improved, regressed, pValue) => {
      expect(exactMcNemarPValue({ improved, regressed })).toBeCloseTo(
        pValue,
        12
      );
    });

    test('is symmetric in the direction of the change', () => {
      expect(exactMcNemarPValue({ improved: 2, regressed: 7 })).toBe(
        exactMcNemarPValue({ improved: 7, regressed: 2 })
      );
    });

    test('a balanced flip is capped at 1, not doubled past it', () => {
      expect(exactMcNemarPValue({ improved: 2, regressed: 1 })).toBe(1);
      expect(exactMcNemarPValue({ improved: 1, regressed: 0 })).toBe(1);
    });

    test('is 1 when no item changed sides', () => {
      expect(exactMcNemarPValue({ improved: 0, regressed: 0 })).toBe(1);
    });

    test('stays finite over thousands of flipped items', () => {
      expect(
        exactMcNemarPValue({ improved: 2900, regressed: 3000 })
      ).toBeCloseTo(0.197439, 6);

      const lopsided = exactMcNemarPValue({ improved: 1000, regressed: 0 });
      expect(Number.isFinite(lopsided)).toBe(true);
      expect(lopsided).toBeGreaterThanOrEqual(0);
      expect(lopsided).toBeLessThan(1e-200);
    });
  });
});
