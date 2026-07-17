import { db } from 'src/db';
import { getEffectivePrice } from 'src/lib/priceBook';
import {
  createFormationProjectPrice,
  deleteFormationProjectPrice,
  getFormationProjectPrice,
  updateFormationProjectPrice,
} from 'src/lib/priceBookFormation';

/**
 * Formation-managed project prices are the write path behind the
 * `project_price` formation resource. They have no dedicated REST entry point
 * (the formation apply flow reaches them), so their DB behavior is covered
 * directly here. These verify the deploy-time goal: a formation-seeded price
 * resolves at the project + provider-slug tier, so a freshly deployed stack
 * produces billing-grade cost with no manual step.
 */
describe('priceBookFormation', () => {
  describe('formation-managed project prices', () => {
    test('a formation-created price is live immediately and prices at the project tier', async () => {
      const project = await db.Project.create({ name: 'fm-price-live' });

      const created = await createFormationProjectPrice({
        projectId: project.id as number,
        provider: 'openai',
        model: 'fm-live-model',
        component: 'output_tokens',
        unit: 'token',
        unitPrice: 0.00002,
      });
      expect(created.id).toMatch(/^price_/);
      expect(created.projectId).toBe(project.publicId);

      // No effective_from was given, so it defaults to deploy time (<= now):
      // a generation run right after deploy is priced rather than left null.
      const effective = await getEffectivePrice({
        provider: 'openai',
        model: 'fm-live-model',
        component: 'output_tokens',
        aiProviderId: null,
        projectId: project.id as number,
        at: new Date(),
      });
      expect(effective?.unitPrice).toBe('0.00002');
    });

    test('update mutates the same row and read reflects it', async () => {
      const project = await db.Project.create({ name: 'fm-price-update' });

      const created = await createFormationProjectPrice({
        projectId: project.id as number,
        provider: 'openai',
        model: 'fm-upd-model',
        component: 'input_tokens',
        unit: 'token',
        unitPrice: 0.00001,
      });

      const updated = await updateFormationProjectPrice({
        id: created.id,
        unitPrice: 0.00009,
      });
      expect(updated.id).toBe(created.id);
      expect(updated.unitPrice).toBe(0.00009);

      const read = await getFormationProjectPrice({ id: created.id });
      expect(read?.unitPrice).toBe(0.00009);
    });

    test('update throws RESOURCE_NOT_FOUND for a missing price', async () => {
      await expect(
        updateFormationProjectPrice({ id: 'price_missing', unitPrice: 1 })
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    test('an invalid effective_from is rejected', async () => {
      const project = await db.Project.create({ name: 'fm-price-badts' });
      await expect(
        createFormationProjectPrice({
          projectId: project.id as number,
          provider: 'openai',
          model: 'fm-badts-model',
          component: 'output_tokens',
          unit: 'token',
          unitPrice: 0.00001,
          effectiveFrom: 'not-a-timestamp',
        })
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    test('get returns null and delete is a no-op after removal', async () => {
      const project = await db.Project.create({ name: 'fm-price-del' });
      const created = await createFormationProjectPrice({
        projectId: project.id as number,
        provider: 'openai',
        model: 'fm-del-model',
        component: 'output_tokens',
        unit: 'token',
        unitPrice: 0.00001,
      });

      await deleteFormationProjectPrice({ id: created.id });
      expect(await getFormationProjectPrice({ id: created.id })).toBeNull();
      // Idempotent: deleting an already-absent row does not throw.
      await expect(
        deleteFormationProjectPrice({ id: created.id })
      ).resolves.toBeUndefined();
    });
  });
});
