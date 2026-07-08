import { db } from 'src/db';
import {
  computeCostUsd,
  DEFAULT_PRICE_EFFECTIVE_FROM,
  getEffectivePrice,
  seedDefaultPrices,
} from 'src/lib/priceBook';

/**
 * Pure cost arithmetic plus the DB-backed effective-price selection and default
 * seeding. computeCostUsd/getEffectivePrice/seedDefaultPrices have no direct
 * REST entry point (they run inside the metering write path and at startup), so
 * they are covered here directly.
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
  });

  describe('seedDefaultPrices', () => {
    test('seeds shipped defaults and is idempotent', async () => {
      await seedDefaultPrices();
      const first = await db.PriceBook.count();
      expect(first).toBeGreaterThan(0);

      const gpt4o = await getEffectivePrice({
        provider: 'openai',
        model: 'gpt-4o',
        at: new Date(),
      });
      expect(gpt4o).not.toBeNull();

      await seedDefaultPrices();
      expect(await db.PriceBook.count()).toBe(first);
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
        at: new Date('2024-06-01T00:00:00.000Z'),
      });
      expect(effective?.inputPricePerM).toBe('2');
    });

    test('returns null when no row covers the provider/model', async () => {
      expect(
        await getEffectivePrice({
          provider: 'nope',
          model: 'no-model',
          at: new Date(),
        })
      ).toBeNull();
    });
  });

  test('DEFAULT_PRICE_EFFECTIVE_FROM is in the past so defaults apply', () => {
    expect(DEFAULT_PRICE_EFFECTIVE_FROM.getTime()).toBeLessThan(Date.now());
  });
});
