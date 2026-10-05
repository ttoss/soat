import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  startStubChatProvider,
  type StubChatProvider,
} from '../../fixtures/stubChatProvider';
import { authenticatedTestClient } from '../../testClient';

/**
 * The `project_price` formation resource: a price row at the project +
 * provider-slug tier, so a freshly deployed stack meters billing-grade cost
 * with no manual pricing step. Unlike the price routes, a formation's
 * `effective_from` may lie in the past and defaults to deploy time.
 */

type PriceRow = {
  id: string;
  model: string;
  component: string;
  unit_price: number;
  effective_from: string;
};

describe('Formations — project_price resources', () => {
  let adminToken: string;
  let projectId: string;
  let stub: StubChatProvider;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'formationprices',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    stub = await startStubChatProvider();
  });

  afterAll(async () => {
    await stub.close();
  });

  const priceProps = (model: string, extra: Record<string, unknown> = {}) => {
    return {
      provider: 'ollama',
      model,
      component: 'output_tokens',
      unit: 'token',
      unit_price: 0.00002,
      ...extra,
    };
  };

  const template = (properties: Record<string, unknown>) => {
    return {
      resources: { Price: { type: 'project_price', properties } },
    };
  };

  const deploy = (args: {
    name: string;
    properties: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(adminToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: args.name,
        template: template(args.properties),
      });
  };

  const update = (args: {
    formationId: string;
    properties: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(adminToken)
      .put(`/api/v1/formations/${args.formationId}`)
      .send({ template: template(args.properties) });
  };

  const projectPrice = async (model: string): Promise<PriceRow | undefined> => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/projects/${projectId}/prices`
    );
    expect(res.status).toBe(200);
    return (res.body.prices as PriceRow[]).find((price) => {
      return price.model === model;
    });
  };

  describe('POST /api/v1/formations', () => {
    test('a price deployed with no effective_from prices the next generation at the project tier', async () => {
      const model = 'fpp-live-model';
      // A global row for the same SKU, which the project tier outranks.
      const globalRes = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              provider: 'ollama',
              model,
              component: 'output_tokens',
              unit: 'token',
              unit_price: 0.009,
              effective_from: '2020-01-01T00:00:00.000Z',
            },
          ],
        });
      expect(globalRes.status).toBe(200);

      const deployed = await deploy({
        name: 'fpp-live',
        properties: priceProps(model),
      });
      expect(deployed.status).toBe(201);
      expect(deployed.body.status).toBe('active');

      const providerRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'fpp-live-provider',
          provider: 'ollama',
          default_model: model,
          base_url: stub.baseUrl,
        });
      expect(providerRes.status).toBe(201);
      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: providerRes.body.id,
          name: 'fpp-live-agent',
        });
      expect(agentRes.status).toBe(201);

      const genRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentRes.body.id}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });
      expect(genRes.status).toBe(200);

      const events = await authenticatedTestClient(adminToken).get(
        `/api/v1/usage/events?generation_id=${genRes.body.id}`
      );
      expect(events.status).toBe(200);
      const output = events.body.data[0].components.find(
        (component: { component: string }) => {
          return component.component === 'output_tokens';
        }
      );
      // The stub reports one completion token.
      expect(Number(output.unit_price)).toBe(0.00002);
      expect(Number(output.cost_usd)).toBeCloseTo(0.00002, 10);
    });

    test('an explicit effective_from is stored as given', async () => {
      const res = await deploy({
        name: 'fpp-explicit',
        properties: priceProps('fpp-explicit-model', {
          effective_from: '2030-01-01T00:00:00.000Z',
        }),
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');

      expect((await projectPrice('fpp-explicit-model'))?.effective_from).toBe(
        '2030-01-01T00:00:00.000Z'
      );
    });

    test('an unparseable effective_from fails the deploy', async () => {
      const res = await deploy({
        name: 'fpp-bad-timestamp',
        properties: priceProps('fpp-bad-timestamp-model', {
          effective_from: 'not-a-timestamp',
        }),
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await projectPrice('fpp-bad-timestamp-model')).toBeUndefined();
    });
  });

  describe('PUT /api/v1/formations/:formation_id', () => {
    test('moves effective_from on the same row and keeps its unit_price', async () => {
      const model = 'fpp-update-model';
      const deployed = await deploy({
        name: 'fpp-update',
        properties: priceProps(model, {
          effective_from: '2030-01-01T00:00:00.000Z',
        }),
      });
      expect(deployed.status).toBe(201);
      const before = await projectPrice(model);

      const res = await update({
        formationId: deployed.body.id,
        properties: priceProps(model, {
          effective_from: '2031-06-01T00:00:00.000Z',
        }),
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      const after = await projectPrice(model);
      expect(after?.id).toBe(before?.id);
      expect(after?.effective_from).toBe('2031-06-01T00:00:00.000Z');
      expect(after?.unit_price).toBe(0.00002);
    });

    test('a negative unit_price fails the update and leaves the row', async () => {
      const model = 'fpp-negative-model';
      const deployed = await deploy({
        name: 'fpp-negative',
        properties: priceProps(model),
      });
      expect(deployed.status).toBe(201);

      const res = await update({
        formationId: deployed.body.id,
        properties: priceProps(model, { unit_price: -1 }),
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect((await projectPrice(model))?.unit_price).toBe(0.00002);
    });
  });

  /**
   * Two formations declaring the same price at the same `effective_from`
   * manage one row, since the row is keyed on that tuple. Deleting one deletes
   * the row out from under the other, which then reads as drift.
   */
  describe('a price row removed under its formation', () => {
    const SHARED = priceProps('fpp-shared-model', {
      effective_from: '2032-01-01T00:00:00.000Z',
    });

    const deployPair = async (name: string) => {
      const first = await deploy({ name: `${name}-a`, properties: SHARED });
      const second = await deploy({ name: `${name}-b`, properties: SHARED });
      expect(first.body.status).toBe('active');
      expect(second.body.status).toBe('active');
      const removed = await authenticatedTestClient(adminToken).delete(
        `/api/v1/formations/${first.body.id}`
      );
      expect(removed.status).toBe(200);
      return second.body.id as string;
    };

    test('a plan reads it as absent', async () => {
      const formationId = await deployPair('fpp-drift-plan');

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: formationId,
          template: template(SHARED),
        });

      expect(res.status).toBe(200);
      expect(res.body.changes).toEqual([
        expect.objectContaining({
          logical_id: 'Price',
          action: 'update',
          diff: expect.objectContaining({ current: null }),
        }),
      ]);
    });

    test('an update fails as not found', async () => {
      const formationId = await deployPair('fpp-drift-update');

      const res = await update({
        formationId,
        properties: { ...SHARED, unit_price: 0.00009 },
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('deleting the formation succeeds', async () => {
      const formationId = await deployPair('fpp-drift-delete');

      const res = await authenticatedTestClient(adminToken).delete(
        `/api/v1/formations/${formationId}`
      );

      expect(res.status).toBe(200);
    });
  });
});
