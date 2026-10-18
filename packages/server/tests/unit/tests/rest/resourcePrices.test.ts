import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { App, bodyParser } from '@ttoss/http-server';
import {
  createMcpRouter,
  McpServer,
  registerTools,
} from '@ttoss/http-server-mcp';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

type Component = {
  component: string;
  quantity: number;
  cost_usd: number | null;
};

type UsageEvent = {
  tool_id: string | null;
  cost_usd: number | null;
  components: Component[];
};

/**
 * A project prices its own tool with resource rows: each adds a component to
 * the tool's `tool_execution` event, its quantity read off the call. A call
 * through a share is priced from the owner's rows, never the caller's.
 */
describe('Resource prices', () => {
  let toolStub: Server;
  let toolUrl: string;
  const mcpServers: Server[] = [];
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;
  let publisherKey: string;
  let toolCount = 0;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const startToolStub = async (): Promise<string> => {
    toolStub = createServer((req, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ page_count: 3, label: 'many' }));
      });
    });
    await new Promise<void>((resolve) => {
      toolStub.listen(0, '127.0.0.1', resolve);
    });
    const { port } = toolStub.address() as AddressInfo;
    return `http://127.0.0.1:${port}/hook`;
  };

  const startMcpServer = async (args: { defer: boolean }): Promise<string> => {
    const mcp = new McpServer({ name: 'priced', version: '1.0.0' });
    registerTools({
      server: mcp,
      tools: [
        {
          name: 'echo',
          description: 'Echoes.',
          inputSchema: { type: 'object' as const, properties: {} },
          handler: async () => {
            return { content: [{ type: 'text' as const, text: '{}' }] };
          },
        },
      ],
      defer: args.defer,
    });
    const app = new App();
    app.use(bodyParser());
    app.use(createMcpRouter(mcp).routes());
    const server = app.listen(0, '127.0.0.1');
    mcpServers.push(server);
    await new Promise<void>((resolve) => {
      server.once('listening', resolve);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  };

  const createTool = async (extra: Record<string, unknown> = {}) => {
    toolCount += 1;
    const res = await admin()
      .post('/api/v1/tools')
      .send({
        project_id: publisherId,
        name: `pricedTool${String(toolCount)}`,
        type: 'http',
        parameters: {
          type: 'object',
          properties: { pages: { type: 'number' } },
        },
        execute: { url: toolUrl, method: 'POST' },
        ...extra,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const srn = (toolId: string) => {
    return `srn:${publisherId}:tool:${toolId}`;
  };

  const priceRow = (args: {
    toolId: string;
    component?: string;
    quantity?: unknown;
    unitPrice?: number;
    effectiveFrom?: string;
  }) => {
    return {
      meter_type: 'tool_execution',
      resource: srn(args.toolId),
      component: args.component ?? 'page',
      unit: 'count',
      ...(args.quantity === undefined ? {} : { quantity: args.quantity }),
      unit_price: args.unitPrice ?? 0.002,
      effective_from: args.effectiveFrom ?? '2026-01-01T00:00:00Z',
    };
  };

  const putPrices = (args: {
    projectId: string;
    rows: Array<Record<string, unknown>>;
  }) => {
    return admin()
      .put(`/api/v1/projects/${args.projectId}/prices`)
      .send({ prices: args.rows });
  };

  const callTool = (args: {
    toolId: string;
    key: string;
    action?: string;
    input?: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(args.key)
      .post(`/api/v1/tools/${args.toolId}/call`)
      .send({
        ...(args.action ? { action: args.action } : {}),
        input: args.input ?? {},
      });
  };

  const lastEvent = async (args: { toolId: string; key: string }) => {
    const res = await authenticatedTestClient(args.key)
      .get('/api/v1/usage/events')
      .query({ meter_type: 'tool_execution' });
    expect(res.status).toBe(200);
    return (res.body.data as UsageEvent[]).find((event) => {
      return event.tool_id === args.toolId;
    });
  };

  const componentOf = (event: UsageEvent | undefined, name: string) => {
    return event?.components.find((component) => {
      return component.component === name;
    });
  };

  beforeAll(async () => {
    toolUrl = await startToolStub();
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'resourcepriceadmin', password: 'supersecret' });
    adminToken = await loginAs('resourcepriceadmin', 'supersecret');

    publisherId = (
      await admin().post('/api/v1/projects').send({ name: 'Publisher' })
    ).body.id;
    granteeId = (
      await admin().post('/api/v1/projects').send({ name: 'Grantee' })
    ).body.id;
    publisherKey = (
      await admin()
        .post('/api/v1/api-keys')
        .send({ name: 'Publisher key', project_id: publisherId })
    ).body.key;
    granteeKey = (
      await admin()
        .post('/api/v1/api-keys')
        .send({ name: 'Grantee key', project_id: granteeId })
    ).body.key;
  });

  afterAll(async () => {
    await Promise.all(
      [toolStub, ...mcpServers].map((server) => {
        return new Promise<void>((resolve) => {
          server.close(() => {
            return resolve();
          });
        });
      })
    );
  });

  describe('PUT /api/v1/projects/:project_id/prices', () => {
    test('the owner writes a resource row for its own tool', async () => {
      const toolId = await createTool();

      const response = await putPrices({
        projectId: publisherId,
        rows: [priceRow({ toolId, quantity: { var: 'response.page_count' } })],
      });

      expect(response.status).toBe(200);
      expect(response.body.prices[0]).toMatchObject({
        meter_type: 'tool_execution',
        resource: srn(toolId),
        component: 'page',
        quantity: { var: 'response.page_count' },
      });
    });

    test("another project naming the owner's tool is 403", async () => {
      const toolId = await createTool();

      const response = await putPrices({
        projectId: granteeId,
        rows: [priceRow({ toolId })],
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('a tool_execution row without a resource is 400', async () => {
      const response = await putPrices({
        projectId: publisherId,
        rows: [
          {
            meter_type: 'tool_execution',
            provider: 'soat',
            model: 'tool-call',
            component: 'tool_call',
            unit: 'tool_call',
            unit_price: 0.01,
            effective_from: '2026-01-01T00:00:00Z',
          },
        ],
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a client tool cannot be priced', async () => {
      const client = await createTool({ type: 'client', execute: undefined });

      const response = await putPrices({
        projectId: publisherId,
        rows: [priceRow({ toolId: client })],
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a now-dated row on a priced key is 400', async () => {
      const toolId = await createTool();
      await putPrices({ projectId: publisherId, rows: [priceRow({ toolId })] });

      const response = await putPrices({
        projectId: publisherId,
        rows: [priceRow({ toolId, effectiveFrom: new Date().toISOString() })],
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('a priced call', () => {
    test('prices a pipeline on its own execution', async () => {
      const pipeline = await createTool({
        type: 'pipeline',
        execute: undefined,
        pipeline: { steps: [], output: { pages: 4 } },
      });
      await putPrices({
        projectId: publisherId,
        rows: [
          priceRow({ toolId: pipeline, quantity: { var: 'response.pages' } }),
        ],
      });

      expect(
        (await callTool({ toolId: pipeline, key: publisherKey })).status
      ).toBe(200);

      const event = await lastEvent({ toolId: pipeline, key: publisherKey });
      expect(componentOf(event, 'page')).toMatchObject({
        quantity: 4,
        cost_usd: 0.008,
      });
    });

    test('adds the resource component, read off the response', async () => {
      const toolId = await createTool();
      await putPrices({
        projectId: publisherId,
        rows: [priceRow({ toolId, quantity: { var: 'response.page_count' } })],
      });

      expect((await callTool({ toolId, key: publisherKey })).status).toBe(200);

      const event = await lastEvent({ toolId, key: publisherKey });
      expect(componentOf(event, 'tool_call')).toMatchObject({ quantity: 1 });
      expect(componentOf(event, 'page')).toMatchObject({
        quantity: 3,
        cost_usd: 0.006,
      });
      expect(event?.cost_usd).toBe(0.006);
    });

    test('reads the input, presets merged', async () => {
      const toolId = await createTool({ preset_parameters: { pages: 7 } });
      await putPrices({
        projectId: publisherId,
        rows: [priceRow({ toolId, quantity: { var: 'input.pages' } })],
      });

      await callTool({ toolId, key: publisherKey });

      const event = await lastEvent({ toolId, key: publisherKey });
      expect(componentOf(event, 'page')).toMatchObject({ quantity: 7 });
    });

    test('reads the response after output_mapping', async () => {
      const toolId = await createTool({
        output_mapping: { pages: { var: 'output.page_count' } },
      });
      await putPrices({
        projectId: publisherId,
        rows: [priceRow({ toolId, quantity: { var: 'response.pages' } })],
      });

      await callTool({ toolId, key: publisherKey });

      const event = await lastEvent({ toolId, key: publisherKey });
      expect(componentOf(event, 'page')).toMatchObject({ quantity: 3 });
    });

    test('with no quantity, prices one per call', async () => {
      const toolId = await createTool();
      await putPrices({
        projectId: publisherId,
        rows: [priceRow({ toolId, component: 'call', unitPrice: 0.05 })],
      });

      await callTool({ toolId, key: publisherKey });

      const event = await lastEvent({ toolId, key: publisherKey });
      expect(componentOf(event, 'call')).toMatchObject({
        quantity: 1,
        cost_usd: 0.05,
      });
    });

    test.each([
      ['a string', { var: 'response.label' }],
      ['a negative number', { '-': [0, 1] }],
    ])(
      'an invalid quantity (%s) records zero, no cost and an activity entry',
      async (_label, quantity) => {
        const toolId = await createTool();
        await putPrices({
          projectId: publisherId,
          rows: [priceRow({ toolId, quantity })],
        });

        const call = await callTool({ toolId, key: publisherKey });

        expect(call.status).toBe(200);
        const event = await lastEvent({ toolId, key: publisherKey });
        expect(componentOf(event, 'page')).toMatchObject({
          quantity: 0,
          cost_usd: null,
        });
        const feed = await admin()
          .get('/api/v1/activity')
          .query({ project_id: publisherId, kind: 'usage_quantity_invalid' });
        expect(
          (feed.body.data as Array<{ ref_id: string }>).some((entry) => {
            return entry.ref_id === toolId;
          })
        ).toBe(true);
      }
    );

    test('a future row takes effect at its date', async () => {
      const toolId = await createTool();
      await putPrices({
        projectId: publisherId,
        rows: [priceRow({ toolId, component: 'call', unitPrice: 0.01 })],
      });
      const takesEffect = new Date(Date.now() + 60_000);
      await putPrices({
        projectId: publisherId,
        rows: [
          priceRow({
            toolId,
            component: 'call',
            unitPrice: 0.02,
            effectiveFrom: takesEffect.toISOString(),
          }),
        ],
      });
      jest.useFakeTimers({ advanceTimers: true });
      try {
        await callTool({ toolId, key: publisherKey });
        expect(
          componentOf(await lastEvent({ toolId, key: publisherKey }), 'call')
            ?.cost_usd
        ).toBe(0.01);

        jest.setSystemTime(takesEffect.getTime() + 1_000);
        await callTool({ toolId, key: publisherKey });

        expect(
          componentOf(await lastEvent({ toolId, key: publisherKey }), 'call')
            ?.cost_usd
        ).toBe(0.02);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('a priced mcp call reads the action invoked', () => {
    const ON_ECHO = { if: [{ '==': [{ var: 'action' }, 'echo'] }, 1, 0] };

    test.each([
      ['a listing server', false, 'echo', {}],
      ['a deferred server, by name', true, 'echo', {}],
      [
        "a deferred server, through its proxy's call",
        true,
        'call',
        { name: 'echo', arguments: {} },
      ],
    ])('%s', async (_label, defer, action, input) => {
      const mcpUrl = await startMcpServer({ defer });
      const toolId = await createTool({
        type: 'mcp',
        mcp: { url: mcpUrl },
        parameters: undefined,
        execute: undefined,
      });
      await putPrices({
        projectId: publisherId,
        rows: [priceRow({ toolId, component: 'op', quantity: ON_ECHO })],
      });

      const call = await callTool({ toolId, key: publisherKey, action, input });

      expect(call.status).toBe(200);
      const event = await lastEvent({ toolId, key: publisherKey });
      expect(componentOf(event, 'op')).toMatchObject({ quantity: 1 });
    });
  });

  describe('a call through an accepted share', () => {
    test("is priced from the owner's rows, in the caller's project", async () => {
      const toolId = await createTool();
      await putPrices({
        projectId: publisherId,
        rows: [priceRow({ toolId, quantity: { var: 'response.page_count' } })],
      });
      const share = await admin()
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: srn(toolId),
          actions: ['tools:CallTool'],
          grantee: granteeId,
        });
      await authenticatedTestClient(granteeKey).post(
        `/api/v1/shares/${share.body.id}/accept`
      );

      expect((await callTool({ toolId, key: granteeKey })).status).toBe(200);

      const event = await lastEvent({ toolId, key: granteeKey });
      expect(componentOf(event, 'page')).toMatchObject({
        quantity: 3,
        cost_usd: 0.006,
      });
    });
  });
});
