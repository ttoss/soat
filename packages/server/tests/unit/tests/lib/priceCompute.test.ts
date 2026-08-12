import {
  buildTokenComponents,
  computeComponentCostUsd,
  sumComponentCostUsd,
  sumQuantities,
  validatePriceInput,
} from 'src/lib/priceCompute';

/**
 * Pure pricing/metering arithmetic — no DB, no HTTP. These run inside the
 * metering write path and the price upsert path, so they are covered directly.
 */
describe('priceCompute', () => {
  describe('computeComponentCostUsd', () => {
    test('multiplies quantity by the per-unit price', () => {
      // 3600 compute-seconds × 0.0001 USD = 0.36
      expect(
        computeComponentCostUsd({ quantity: 3600, unitPrice: 0.0001 })
      ).toBe('0.3600000000');
    });

    test('prices tokens at a per-token rate', () => {
      // 2000 output tokens × 0.000_01 USD/token = 0.02
      expect(
        computeComponentCostUsd({ quantity: 2000, unitPrice: 0.00001 })
      ).toBe('0.0200000000');
    });

    test('returns null when the component is unpriced', () => {
      expect(
        computeComponentCostUsd({ quantity: 100, unitPrice: null })
      ).toBeNull();
      expect(
        computeComponentCostUsd({ quantity: 100, unitPrice: undefined })
      ).toBeNull();
    });
  });

  describe('sumComponentCostUsd', () => {
    test('sums the priced components', () => {
      expect(sumComponentCostUsd(['0.10', '0.02', null])).toBe('0.1200000000');
    });

    test('returns null when nothing is priced', () => {
      expect(sumComponentCostUsd([null, null])).toBeNull();
      expect(sumComponentCostUsd([])).toBeNull();
    });
  });

  /**
   * Quantities are DECIMAL strings, and a rollup sums many of them. Accumulating
   * with `+=` on numbers leaks binary-float error into a billing-adjacent field:
   * the production meter reported 2070.1550000000016 compute-seconds for a
   * project whose events summed to exactly 2070.155. Costs never showed this
   * because `sumComponentCostUsd` fixes the scale on the way out; a quantity has
   * no fixed scale to round to (gb_day carries nine decimals, tokens none), so
   * the sum itself has to be exact.
   */
  describe('sumQuantities', () => {
    test('sums integers exactly', () => {
      expect(sumQuantities(['724352', '4330368'])).toBe(5054720);
      expect(sumQuantities(['2471'])).toBe(2471);
    });

    test('sums fractional quantities without float drift', () => {
      // The classic float trap: 0.1 + 0.2 !== 0.3 in binary floating point.
      expect(sumQuantities(['0.1', '0.2'])).toBe(0.3);
      // The production case, reduced: many 3-decimal compute-second readings.
      expect(sumQuantities(['1035.075', '1035.08'])).toBe(2070.155);
    });

    test('keeps the full scale of a small measure', () => {
      // gb_day quantities are tiny and must not be rounded away.
      expect(sumQuantities(['0.000208672', '0.000208672'])).toBe(0.000417344);
    });

    test('sums across mixed scales', () => {
      expect(sumQuantities(['1', '0.5', '0.000000001'])).toBe(1.500000001);
    });

    test('is zero for no quantities', () => {
      expect(sumQuantities([])).toBe(0);
    });

    test('handles a long run of decimals without accumulating error', () => {
      // 1000 × 0.001 is exactly 1; a float accumulator drifts off it.
      expect(
        sumQuantities(
          Array.from({ length: 1000 }, () => {
            return '0.001';
          })
        )
      ).toBe(1);
    });

    test('sums negative and positive quantities', () => {
      expect(sumQuantities(['1.5', '-0.5'])).toBe(1);
    });
  });

  describe('buildTokenComponents', () => {
    test('splits input into uncached input + cached and keeps output', () => {
      const components = buildTokenComponents({
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 4,
        reasoningTokens: 7,
      });
      const byName = Object.fromEntries(
        components.map((c) => {
          return [c.component, c];
        })
      );
      // uncached input = 10 - 4
      expect(byName.input_tokens.quantity).toBe(6);
      expect(byName.input_tokens.billable).toBe(true);
      expect(byName.cached_tokens.quantity).toBe(4);
      expect(byName.output_tokens.quantity).toBe(20);
      // reasoning is a non-billable detail of output
      expect(byName.reasoning_tokens.quantity).toBe(7);
      expect(byName.reasoning_tokens.billable).toBe(false);
      expect(
        components.every((c) => {
          return c.unit === 'token';
        })
      ).toBe(true);
    });

    test('drops zero-quantity cached and reasoning components', () => {
      const components = buildTokenComponents({
        inputTokens: 5,
        outputTokens: 8,
        cachedTokens: 0,
        reasoningTokens: 0,
      });
      const names = components.map((c) => {
        return c.component;
      });
      expect(names).toEqual(['input_tokens', 'output_tokens']);
      // with no cached tokens, input_tokens is the full input
      expect(components[0].quantity).toBe(5);
    });
  });

  describe('validatePriceInput', () => {
    test('accepts a valid row', () => {
      expect(
        validatePriceInput({
          component: 'input_tokens',
          unit: 'token',
          unitPrice: 0.0000025,
        })
      ).toBeNull();
    });

    test('requires component and unit', () => {
      expect(validatePriceInput({ unit: 'token', unitPrice: 1 })).toMatch(
        /component is required/
      );
      expect(
        validatePriceInput({ component: 'input_tokens', unitPrice: 1 })
      ).toMatch(/unit is required/);
    });

    test('rejects a missing or negative unit price', () => {
      expect(
        validatePriceInput({ component: 'input_tokens', unit: 'token' })
      ).toMatch(/unit_price/);
      expect(
        validatePriceInput({
          component: 'input_tokens',
          unit: 'token',
          unitPrice: -1,
        })
      ).toMatch(/non-negative/);
    });
  });
});
