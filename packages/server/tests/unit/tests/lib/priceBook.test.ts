import { db } from 'src/db';
import { computeCostUsd, getEffectivePrice } from 'src/lib/priceBook';

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
