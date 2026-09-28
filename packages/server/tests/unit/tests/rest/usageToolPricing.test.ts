import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

// Price rows for the `tool_execution` meter: a generic `soat/tool-call` row, a
// row keyed to one tool, and a `quantity` read off the call.

type WireComponent = {
  component: string;
  quantity: number;
  unit: string;
  unit_price: number | null;
  cost_usd: number | null;
  price_id: string | null;
};

type WireEvent = {
  tool_id: string | null;
  cost_usd: number | null;
  components: WireComponent[];
};

const PAST = '2000-01-01T00:00:00.000Z';
const GENERIC_UNIT_PRICE = 0.001;

describe('tool_execution pricing', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'toolprice',
      policyActions: ['tools:CallTool', 'usage:ListEvents'],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            page_count: 3,
            usage: { cost_usd: 0.5 },
            text: 'three',
            negative: -2,
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Effective now, so it is written directly: the API only takes a past
    // `effective_from` for a component nothing has priced yet.
    await db.PriceBook.create({
      aiProviderId: null,
      projectId: null,
      toolId: null,
      meterType: 'tool_execution',
      provider: 'soat',
      model: 'tool-call',
      component: 'tool_call',
      unit: 'tool_call',
      unitPrice: String(GENERIC_UNIT_PRICE),
      effectiveFrom: new Date(PAST),
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const createTool = async (): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: `priced-${Math.random().toString(36).slice(2, 10)}`,
        type: 'http',
        execute: { url: `${url}/ocr`, method: 'POST' },
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const putToolPrice = (row: Record<string, unknown>) => {
    return authenticatedTestClient(adminToken)
      .put('/api/v1/usage/prices')
      .send({
        prices: [
          {
            meter_type: 'tool_execution',
            provider: 'soat',
            model: 'tool-call',
            effective_from: PAST,
            ...row,
          },
        ],
      });
  };

  const callAndReadEvent = async (
    toolId: string,
    input: Record<string, unknown> = {}
  ): Promise<WireEvent> => {
    const call = await authenticatedTestClient(adminToken)
      .post(`/api/v1/tools/${toolId}/call`)
      .send({ input });
    expect(call.status).toBe(200);
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/usage/events?meter_type=tool_execution&tool_id=${toolId}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    return res.body.data[0];
  };

  const componentNamed = (event: WireEvent, name: string): WireComponent => {
    const component = event.components.find((c) => {
      return c.component === name;
    });
    expect(component).toBeDefined();
    return component as WireComponent;
  };

  describe('resolution', () => {
    test('the generic row prices a call of any tool', async () => {
      const toolId = await createTool();

      const event = await callAndReadEvent(toolId);

      expect(event.cost_usd).toBe(GENERIC_UNIT_PRICE);
      expect(event.components).toEqual([
        expect.objectContaining({
          component: 'tool_call',
          quantity: 1,
          unit_price: GENERIC_UNIT_PRICE,
          cost_usd: GENERIC_UNIT_PRICE,
        }),
      ]);
    });

    test('a tool-keyed row wins over the generic row', async () => {
      const toolId = await createTool();
      const tool = await db.Tool.findOne({ where: { publicId: toolId } });
      await db.PriceBook.create({
        aiProviderId: null,
        projectId: null,
        toolId: tool?.id,
        meterType: 'tool_execution',
        provider: 'soat',
        model: 'tool-call',
        component: 'tool_call',
        unit: 'tool_call',
        unitPrice: '0.05',
        effectiveFrom: new Date(PAST),
      });

      const event = await callAndReadEvent(toolId);

      expect(event.cost_usd).toBe(0.05);
      expect(componentNamed(event, 'tool_call')).toMatchObject({
        quantity: 1,
        unit_price: 0.05,
        cost_usd: 0.05,
      });
    });

    test("a tool-keyed row does not price another tool's calls", async () => {
      const priced = await createTool();
      const other = await createTool();
      expect(
        (
          await putToolPrice({
            tool_id: priced,
            component: 'lookup',
            unit: 'call',
            unit_price: 0.2,
          })
        ).status
      ).toBe(200);

      const event = await callAndReadEvent(other);

      expect(
        event.components.map((c) => {
          return c.component;
        })
      ).toEqual(['tool_call']);
      expect(event.cost_usd).toBe(GENERIC_UNIT_PRICE);
    });
  });

  describe('quantity', () => {
    test('reads the response', async () => {
      const toolId = await createTool();
      const put = await putToolPrice({
        tool_id: toolId,
        component: 'page',
        unit: 'page',
        quantity: { var: 'response.page_count' },
        unit_price: 0.002,
      });
      expect(put.status).toBe(200);

      const event = await callAndReadEvent(toolId);

      expect(componentNamed(event, 'page')).toMatchObject({
        quantity: 3,
        unit: 'page',
        unit_price: 0.002,
        cost_usd: 0.006,
        price_id: put.body.prices[0].id,
      });
      expect(event.cost_usd).toBe(0.007);
    });

    test('marks up a cost the tool reports', async () => {
      const toolId = await createTool();
      expect(
        (
          await putToolPrice({
            tool_id: toolId,
            component: 'cost',
            unit: 'usd',
            quantity: { var: 'response.usage.cost_usd' },
            unit_price: 1.3,
          })
        ).status
      ).toBe(200);

      const event = await callAndReadEvent(toolId);

      expect(componentNamed(event, 'cost')).toMatchObject({
        quantity: 0.5,
        cost_usd: 0.65,
      });
    });

    test('reads the input', async () => {
      const toolId = await createTool();
      expect(
        (
          await putToolPrice({
            tool_id: toolId,
            component: 'item',
            unit: 'item',
            quantity: { var: 'input.count' },
            unit_price: 0.01,
          })
        ).status
      ).toBe(200);

      const event = await callAndReadEvent(toolId, { count: 4 });

      expect(componentNamed(event, 'item')).toMatchObject({
        quantity: 4,
        cost_usd: 0.04,
      });
    });

    test('absent is a flat price of one unit per call', async () => {
      const toolId = await createTool();
      expect(
        (
          await putToolPrice({
            tool_id: toolId,
            component: 'flat',
            unit: 'call',
            unit_price: 0.25,
          })
        ).status
      ).toBe(200);

      const event = await callAndReadEvent(toolId);

      expect(componentNamed(event, 'flat')).toMatchObject({
        quantity: 1,
        cost_usd: 0.25,
      });
    });

    test.each([
      ['a missing path', { var: 'response.missing' }],
      ['a string', { var: 'response.text' }],
      ['a negative number', { var: 'response.negative' }],
    ])(
      '%s records the component unpriced and signals it, and the call succeeds',
      async (_label, quantity) => {
        const toolId = await createTool();
        const put = await putToolPrice({
          tool_id: toolId,
          component: 'bad',
          unit: 'page',
          quantity,
          unit_price: 1,
        });
        expect(put.status).toBe(200);

        const event = await callAndReadEvent(toolId);

        expect(componentNamed(event, 'bad')).toMatchObject({
          quantity: 0,
          unit_price: null,
          cost_usd: null,
          price_id: null,
        });
        expect(event.cost_usd).toBe(GENERIC_UNIT_PRICE);

        const activity = await authenticatedTestClient(adminToken).get(
          `/api/v1/activity?project_id=${projectId}&kind=usage_quantity_invalid`
        );
        expect(activity.status).toBe(200);
        const entry = activity.body.data.find((e: { ref_id: string }) => {
          return e.ref_id === toolId;
        });
        expect(entry).toMatchObject({
          severity: 'warning',
          detail: {
            tool_id: toolId,
            component: 'bad',
            price_id: put.body.prices[0].id,
          },
        });
      }
    );
  });

  describe('PUT /api/v1/usage/prices', () => {
    test('returns 401 without auth', async () => {
      const res = await testClient
        .put('/api/v1/usage/prices')
        .send({ prices: [] });
      expect(res.status).toBe(401);
    });

    test('returns 403 for a non-admin', async () => {
      const toolId = await createTool();
      const res = await authenticatedTestClient(userToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              meter_type: 'tool_execution',
              provider: 'soat',
              model: 'tool-call',
              tool_id: toolId,
              component: 'page',
              unit: 'page',
              unit_price: 1,
              effective_from: PAST,
            },
          ],
        });
      expect(res.status).toBe(403);
    });

    test('echoes tool_id and quantity', async () => {
      const toolId = await createTool();
      const res = await putToolPrice({
        tool_id: toolId,
        component: 'page',
        unit: 'page',
        quantity: { var: 'response.page_count' },
        unit_price: 0.002,
      });
      expect(res.status).toBe(200);
      expect(res.body.prices[0]).toMatchObject({
        tool_id: toolId,
        quantity: { var: 'response.page_count' },
        meter_type: 'tool_execution',
      });
    });

    test('refuses tool_id outside the tool_execution meter', async () => {
      const toolId = await createTool();
      const res = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              provider: 'openai',
              model: 'gpt-4o',
              tool_id: toolId,
              component: 'input_tokens',
              unit: 'token',
              unit_price: 1,
              effective_from: PAST,
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a quantity that is not a JSON Logic expression', async () => {
      const res = await putToolPrice({
        component: 'page',
        unit: 'page',
        quantity: { pages: 3 },
        unit_price: 1,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses an unknown tool', async () => {
      const res = await putToolPrice({
        tool_id: 'tool_doesnotexist0000',
        component: 'page',
        unit: 'page',
        unit_price: 1,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test('refuses a back-dated tool row for a component the generic row already prices', async () => {
      const toolId = await createTool();
      const res = await putToolPrice({
        tool_id: toolId,
        component: 'tool_call',
        unit: 'tool_call',
        unit_price: 1,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/usage/prices', () => {
    test('lists tool-keyed rows to an admin and not to anyone else', async () => {
      const toolId = await createTool();
      expect(
        (
          await putToolPrice({
            tool_id: toolId,
            component: 'listed',
            unit: 'call',
            unit_price: 1,
          })
        ).status
      ).toBe(200);
      const hasRow = (prices: Array<{ tool_id: string | null }>) => {
        return prices.some((price) => {
          return price.tool_id === toolId;
        });
      };

      const admin = await authenticatedTestClient(adminToken).get(
        '/api/v1/usage/prices'
      );
      expect(admin.status).toBe(200);
      expect(hasRow(admin.body.prices)).toBe(true);

      const user = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/prices'
      );
      expect(user.status).toBe(200);
      expect(hasRow(user.body.prices)).toBe(false);
      expect(
        user.body.prices.some((price: { component: string }) => {
          return price.component === 'tool_call';
        })
      ).toBe(true);
    });
  });
});
