import { db } from 'src/db';
import { getEffectivePrice } from 'src/lib/priceBook';

/**
 * DB-backed effective-price selection. getEffectivePrice has no direct REST
 * entry point (it runs inside the metering write path), and its three-tier
 * resolution is a large branch space that is expensive to drive through HTTP,
 * so it is covered here directly. It now resolves per `(provider, model,
 * component)`.
 */
describe('priceBook', () => {
  describe('getEffectivePrice', () => {
    test('returns the latest row effective at or before the given time', async () => {
      const provider = 'pbtest';
      const model = 'pb-model';
      const component = 'input_tokens';
      const seed = async (unitPrice: string, effectiveFrom: string) => {
        await db.PriceBook.create({
          meterType: 'llm_tokens',
          provider,
          model,
          component,
          unit: 'token',
          unitPrice,
          effectiveFrom: new Date(effectiveFrom),
        });
      };
      await seed('0.001', '2023-01-01T00:00:00.000Z');
      await seed('0.002', '2024-01-01T00:00:00.000Z');
      await seed('0.009', '2999-01-01T00:00:00.000Z'); // future must not win

      const effective = await getEffectivePrice({
        provider,
        model,
        component,
        aiProviderId: null,
        projectId: null,
        at: new Date('2024-06-01T00:00:00.000Z'),
      });
      expect(effective?.unitPrice).toBe('0.002');
    });

    test('returns null when no row covers the provider/model/component', async () => {
      expect(
        await getEffectivePrice({
          provider: 'nope',
          model: 'no-model',
          component: 'output_tokens',
          aiProviderId: null,
          projectId: null,
          at: new Date(),
        })
      ).toBeNull();
    });

    test('resolves per component independently', async () => {
      const provider = 'openai';
      const model = 'component-test-model';
      const past = new Date('2020-01-01T00:00:00.000Z');
      const seed = (component: string, unitPrice: string) => {
        return db.PriceBook.create({
          meterType: 'llm_tokens',
          provider,
          model,
          component,
          unit: 'token',
          unitPrice,
          effectiveFrom: past,
        });
      };
      await seed('input_tokens', '0.000001');
      await seed('output_tokens', '0.000002');

      const at = new Date('2024-06-01T00:00:00.000Z');
      const base = { provider, model, aiProviderId: null, projectId: null, at };
      expect(
        (await getEffectivePrice({ ...base, component: 'input_tokens' }))
          ?.unitPrice
      ).toBe('0.000001');
      expect(
        (await getEffectivePrice({ ...base, component: 'output_tokens' }))
          ?.unitPrice
      ).toBe('0.000002');
      // no cached row for this SKU
      expect(
        await getEffectivePrice({ ...base, component: 'cached_tokens' })
      ).toBeNull();
    });

    test('resolves instance > project+slug > global in priority order', async () => {
      const provider = 'openai';
      const model = 'tier-test-model';
      const component = 'output_tokens';
      const past = new Date('2020-01-01T00:00:00.000Z');

      const project = await db.Project.create({ name: 'tier-price-project' });
      const aiProvider = await db.AiProvider.create({
        projectId: project.id,
        name: 'tier-price-provider',
        provider,
        defaultModel: model,
      });

      const seed = (
        scope: { aiProviderId: number | null; projectId: number | null },
        unitPrice: string
      ) => {
        return db.PriceBook.create({
          ...scope,
          meterType: 'llm_tokens',
          provider,
          model,
          component,
          unit: 'token',
          unitPrice,
          effectiveFrom: past,
        });
      };

      await seed({ aiProviderId: null, projectId: null }, '0.001');
      const at = new Date('2024-06-01T00:00:00.000Z');
      const base = { provider, model, component, at };

      const globalHit = await getEffectivePrice({
        ...base,
        aiProviderId: aiProvider.id,
        projectId: project.id,
      });
      expect(globalHit?.unitPrice).toBe('0.001');

      await seed({ aiProviderId: null, projectId: project.id }, '0.005');
      const projectHit = await getEffectivePrice({
        ...base,
        aiProviderId: aiProvider.id,
        projectId: project.id,
      });
      expect(projectHit?.unitPrice).toBe('0.005');

      await seed({ aiProviderId: aiProvider.id, projectId: null }, '0.009');
      const instanceHit = await getEffectivePrice({
        ...base,
        aiProviderId: aiProvider.id,
        projectId: project.id,
      });
      expect(instanceHit?.unitPrice).toBe('0.009');

      const globalOnly = await getEffectivePrice({
        ...base,
        aiProviderId: null,
        projectId: null,
      });
      expect(globalOnly?.unitPrice).toBe('0.001');
    });
  });
});
