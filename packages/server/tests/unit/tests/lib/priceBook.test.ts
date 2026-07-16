import { db } from 'src/db';
import {
  computeCostUsd,
  getEffectivePrice,
  validatePriceShape,
} from 'src/lib/priceBook';

/**
 * Pure cost arithmetic plus the DB-backed effective-price selection.
 * computeCostUsd/getEffectivePrice have no direct REST entry point (they run
 * inside the metering write path), so they are covered here directly.
 */
describe('priceBook', () => {
  describe('computeCostUsd', () => {
    test('prices input, cached, and output tokens per million', () => {
      // (1000-400)*2.5 + 400*1.25 + 2000*10 = 1500 + 500 + 20000 = 22000
      expect(
        computeCostUsd({
          price: {
            inputPricePerM: '2.5',
            outputPricePerM: '10',
            cachedPricePerM: '1.25',
          },
          inputTokens: 1000,
          outputTokens: 2000,
          cachedTokens: 400,
        })
      ).toBe('0.022000');
    });

    test('falls back to the input rate when no cached rate is set', () => {
      // (100-20)*3 + 20*3 + 50*6 = 240 + 60 + 300 = 600
      expect(
        computeCostUsd({
          price: {
            inputPricePerM: '3',
            outputPricePerM: '6',
            cachedPricePerM: null,
          },
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 20,
        })
      ).toBe('0.000600');
    });

    test('returns null when there is no price', () => {
      expect(
        computeCostUsd({
          price: null,
          inputTokens: 10,
          outputTokens: 20,
          cachedTokens: 0,
        })
      ).toBeNull();
    });

    test('prices a non-LLM meter as quantity × unit_price', () => {
      // 3600 node-seconds × 0.0001 USD = 0.36
      expect(
        computeCostUsd({
          price: {
            meterType: 'node_execution',
            inputPricePerM: null,
            outputPricePerM: null,
            cachedPricePerM: null,
            unitPrice: '0.0001',
          },
          quantity: 3600,
        })
      ).toBe('0.360000');
    });

    test('returns null for a non-LLM meter when quantity or unit price is absent', () => {
      const price = {
        meterType: 'node_execution',
        inputPricePerM: null,
        outputPricePerM: null,
        cachedPricePerM: null,
        unitPrice: '0.0001',
      };
      // No quantity to multiply.
      expect(computeCostUsd({ price, quantity: null })).toBeNull();
      // No unit price on the row.
      expect(
        computeCostUsd({
          price: { ...price, unitPrice: null },
          quantity: 100,
        })
      ).toBeNull();
    });

    test('returns null for an llm_tokens row missing token rates', () => {
      expect(
        computeCostUsd({
          price: {
            meterType: 'llm_tokens',
            inputPricePerM: null,
            outputPricePerM: null,
            cachedPricePerM: null,
          },
          inputTokens: 10,
          outputTokens: 20,
          cachedTokens: 0,
        })
      ).toBeNull();
    });
  });

  describe('validatePriceShape', () => {
    test('accepts a valid llm_tokens price', () => {
      expect(
        validatePriceShape({
          meterType: 'llm_tokens',
          inputPricePerM: 2.5,
          outputPricePerM: 10,
        })
      ).toBeNull();
    });

    test('rejects an llm_tokens price missing token rates', () => {
      expect(
        validatePriceShape({ meterType: 'llm_tokens', inputPricePerM: 2.5 })
      ).toMatch(/input_price_per_m and output_price_per_m/);
    });

    test('rejects an llm_tokens price that also sets a unit price', () => {
      expect(
        validatePriceShape({
          meterType: 'llm_tokens',
          inputPricePerM: 2.5,
          outputPricePerM: 10,
          unitPrice: 0.1,
          unit: 'node_second',
        })
      ).toMatch(/must not set unit_price/);
    });

    test('accepts a valid non-LLM unit price', () => {
      expect(
        validatePriceShape({
          meterType: 'node_execution',
          unitPrice: 0.0001,
          unit: 'node_second',
        })
      ).toBeNull();
    });

    test('rejects a non-LLM price missing unit_price or unit', () => {
      expect(
        validatePriceShape({ meterType: 'node_execution', unitPrice: 0.0001 })
      ).toMatch(/require unit_price and unit/);
    });

    test('rejects a non-LLM price that also sets token rates', () => {
      expect(
        validatePriceShape({
          meterType: 'node_execution',
          unitPrice: 0.0001,
          unit: 'node_second',
          inputPricePerM: 1,
        })
      ).toMatch(/must not set token prices/);
    });
  });

  describe('getEffectivePrice', () => {
    test('returns the latest row effective at or before the given time', async () => {
      const provider = 'pbtest';
      const model = 'pb-model';
      await db.PriceBook.create({
        provider,
        model,
        inputPricePerM: '1',
        outputPricePerM: '1',
        cachedPricePerM: null,
        effectiveFrom: new Date('2023-01-01T00:00:00.000Z'),
      });
      await db.PriceBook.create({
        provider,
        model,
        inputPricePerM: '2',
        outputPricePerM: '2',
        cachedPricePerM: null,
        effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
      });
      // A future row must not win.
      await db.PriceBook.create({
        provider,
        model,
        inputPricePerM: '9',
        outputPricePerM: '9',
        cachedPricePerM: null,
        effectiveFrom: new Date('2999-01-01T00:00:00.000Z'),
      });

      const effective = await getEffectivePrice({
        provider,
        model,
        aiProviderId: null,
        projectId: null,
        at: new Date('2024-06-01T00:00:00.000Z'),
      });
      expect(effective?.inputPricePerM).toBe('2');
    });

    test('returns null when no row covers the provider/model', async () => {
      expect(
        await getEffectivePrice({
          provider: 'nope',
          model: 'no-model',
          aiProviderId: null,
          projectId: null,
          at: new Date(),
        })
      ).toBeNull();
    });

    test('resolves instance > project+slug > global in priority order', async () => {
      // A valid provider slug (the AiProvider.provider column is constrained)
      // with a model unique to this test, so these rows stay isolated.
      const provider = 'openai';
      const model = 'tier-test-model';
      const past = new Date('2020-01-01T00:00:00.000Z');

      const project = await db.Project.create({ name: 'tier-price-project' });
      const aiProvider = await db.AiProvider.create({
        projectId: project.id,
        name: 'tier-price-provider',
        provider,
        defaultModel: model,
      });

      // Global default.
      await db.PriceBook.create({
        aiProviderId: null,
        projectId: null,
        provider,
        model,
        inputPricePerM: '1',
        outputPricePerM: '1',
        cachedPricePerM: null,
        effectiveFrom: past,
      });

      const at = new Date('2024-06-01T00:00:00.000Z');
      const base = { provider, model, at };

      // Only the global exists → global wins.
      const globalHit = await getEffectivePrice({
        ...base,
        aiProviderId: aiProvider.id,
        projectId: project.id,
      });
      expect(globalHit?.inputPricePerM).toBe('1');

      // Add a project+slug price → it wins over global.
      await db.PriceBook.create({
        aiProviderId: null,
        projectId: project.id,
        provider,
        model,
        inputPricePerM: '5',
        outputPricePerM: '5',
        cachedPricePerM: null,
        effectiveFrom: past,
      });
      const projectHit = await getEffectivePrice({
        ...base,
        aiProviderId: aiProvider.id,
        projectId: project.id,
      });
      expect(projectHit?.inputPricePerM).toBe('5');

      // Add a per-instance override → it wins over both.
      await db.PriceBook.create({
        aiProviderId: aiProvider.id,
        projectId: null,
        provider,
        model,
        inputPricePerM: '9',
        outputPricePerM: '9',
        cachedPricePerM: null,
        effectiveFrom: past,
      });
      const instanceHit = await getEffectivePrice({
        ...base,
        aiProviderId: aiProvider.id,
        projectId: project.id,
      });
      expect(instanceHit?.inputPricePerM).toBe('9');

      // A caller with no instance/project still gets the global.
      const globalOnly = await getEffectivePrice({
        ...base,
        aiProviderId: null,
        projectId: null,
      });
      expect(globalOnly?.inputPricePerM).toBe('1');
    });
  });
});
