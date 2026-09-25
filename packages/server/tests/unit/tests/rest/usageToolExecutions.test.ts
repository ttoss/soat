import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

// One `tool_execution` event per outbound tool call, recorded at the protocol
// primitives, and read back through the usage endpoints like any other meter.

type WireEvent = {
  id: string;
  meter_type: string;
  tool_id: string | null;
  outcome: string | null;
  provider: string;
  model: string;
  cost_usd: number | null;
  components: Array<{ component: string; quantity: number }>;
};

const startServer = async (
  handler: http.RequestListener
): Promise<{ server: http.Server; url: string }> => {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
};

const stopServer = (server: http.Server): Promise<void> => {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
};

describe('tool_execution usage', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let httpServer: http.Server;
  let httpUrl: string;
  let mcpServer: http.Server;
  let mcpUrl: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'toolexec',
      policyActions: [
        'tools:CreateTool',
        'tools:CallTool',
        'usage:ListEvents',
        'usage:GetAggregate',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    ({ server: httpServer, url: httpUrl } = await startServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const status = req.url?.startsWith('/fail') ? 500 : 200;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: status === 200 }));
      });
    }));

    ({ server: mcpServer, url: mcpUrl } = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { method: string };
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            parsed.method === 'tools/call'
              ? {
                  jsonrpc: '2.0',
                  id: 2,
                  result: { content: [{ text: '{"ok":true}' }] },
                }
              : { jsonrpc: '2.0', id: 1, result: {} }
          )
        );
      });
    }));
  });

  afterAll(async () => {
    await stopServer(httpServer);
    await stopServer(mcpServer);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const createTool = async (body: Record<string, unknown>): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: `tool-${Math.random().toString(36).slice(2, 10)}`,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createHttpTool = (path = '/ok', extra: object = {}) => {
    return createTool({
      type: 'http',
      execute: { url: `${httpUrl}${path}`, method: 'POST' },
      ...extra,
    });
  };

  const call = (toolId: string, body: object = {}) => {
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/tools/${toolId}/call`)
      .send(body);
  };

  const toolEvents = async (toolId: string): Promise<WireEvent[]> => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/usage/events?meter_type=tool_execution&tool_id=${toolId}`
    );
    expect(res.status).toBe(200);
    return res.body.data;
  };

  describe('recording at the primitives', () => {
    test('an http call writes one event with one tool_call component', async () => {
      const toolId = await createHttpTool();

      const res = await call(toolId);
      expect(res.status).toBe(200);

      const events = await toolEvents(toolId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        meter_type: 'tool_execution',
        tool_id: toolId,
        outcome: 'ok',
        provider: 'soat',
        cost_usd: null,
      });
      expect(events[0].components).toEqual([
        expect.objectContaining({ component: 'tool_call', quantity: 1 }),
      ]);
    });

    test('an http call the target rejects is recorded with outcome error', async () => {
      const toolId = await createHttpTool('/fail');

      const res = await call(toolId);
      expect(res.status).toBe(502);

      const events = await toolEvents(toolId);
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe('error');
    });

    test('a call the egress guard refuses before sending is not recorded', async () => {
      const toolId = await createTool({
        type: 'http',
        execute: { url: 'http://10.255.255.1/blocked', method: 'POST' },
      });

      const res = await call(toolId);
      expect(res.body.error.code).toBe('TOOL_EGRESS_BLOCKED');

      expect(await toolEvents(toolId)).toEqual([]);
    });

    test('an mcp call writes one event', async () => {
      const toolId = await createTool({ type: 'mcp', mcp: { url: mcpUrl } });

      const res = await call(toolId, { action: 'remote-tool' });
      expect(res.status).toBe(200);

      const events = await toolEvents(toolId);
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe('ok');
    });

    test('an mcp call that times out is recorded with outcome timeout', async () => {
      const toolId = await createTool({ type: 'mcp', mcp: { url: mcpUrl } });
      // `AbortSignal.timeout` rejects the fetch with this exact error; waiting
      // out the real five-minute limit is not something a test can do.
      jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(
          new DOMException('The operation timed out.', 'TimeoutError')
        );

      await call(toolId, { action: 'remote-tool' });

      const events = await toolEvents(toolId);
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe('timeout');
    });

    test('a builtin call writes one event', async () => {
      const toolId = await createTool({
        type: 'builtin',
        actions: ['list-tools'],
      });

      const res = await call(toolId, { action: 'list-tools' });
      expect(res.status).toBe(200);

      const events = await toolEvents(toolId);
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe('ok');
    });

    test('a pipeline records one event per step and none of its own', async () => {
      const stepToolId = await createHttpTool();
      const pipelineId = await createTool({
        type: 'pipeline',
        pipeline: {
          steps: [
            { id: 'first', tool_id: stepToolId, input: {} },
            { id: 'second', tool_id: stepToolId, input: {} },
          ],
        },
      });

      const res = await call(pipelineId);
      expect(res.status).toBe(200);

      expect(await toolEvents(stepToolId)).toHaveLength(2);
      expect(await toolEvents(pipelineId)).toEqual([]);
    });

    test('a client tool is never recorded', async () => {
      const toolId = await createTool({ type: 'client' });

      const res = await call(toolId);
      expect(res.body.error.code).toBe('TOOL_CALL_NOT_SUPPORTED');

      expect(await toolEvents(toolId)).toEqual([]);
    });

    test('a call a guardrail blocks is not recorded', async () => {
      const guardrail = await authenticatedTestClient(adminToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: `block-${Math.random().toString(36).slice(2, 10)}`,
          document: { class: 'D' },
        });
      const toolId = await createHttpTool('/ok', {
        guardrail_ids: [guardrail.body.id],
      });

      const res = await call(toolId);
      expect(res.body.error.code).toBe('TOOL_DISPATCH_FAILED');

      expect(await toolEvents(toolId)).toEqual([]);
    });

    test('a call a guardrail releases carries that guardrail on the event', async () => {
      const guardrail = await authenticatedTestClient(adminToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: `allow-${Math.random().toString(36).slice(2, 10)}`,
          document: { class: 'A' },
        });
      const toolId = await createHttpTool('/ok', {
        guardrail_ids: [guardrail.body.id],
      });

      expect((await call(toolId)).status).toBe(200);

      const [event] = await toolEvents(toolId);
      const row = await db.UsageEvent.findOne({
        where: { publicId: event.id },
      });
      expect(row?.guardrailIds).toEqual([guardrail.body.id]);
    });
  });

  describe('attribution', () => {
    test('an orchestration tool node records its run and node', async () => {
      const toolId = await createHttpTool();
      const orchestration = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: `metered-${Math.random().toString(36).slice(2, 10)}`,
          nodes: [{ id: 'call', type: 'tool', tool_id: toolId }],
          edges: [],
        });
      expect(orchestration.status).toBe(201);

      const run = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: orchestration.body.id,
          input: {},
        });
      expect(run.body.status).toBe('succeeded');

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/usage/events?meter_type=tool_execution&orchestration_run_id=${run.body.id}`
      );
      expect(res.body.data).toEqual([
        expect.objectContaining({
          tool_id: toolId,
          orchestration_run_id: run.body.id,
          node_id: 'call',
          outcome: 'ok',
        }),
      ]);
    });
  });

  describe('GET /api/v1/usage/aggregate', () => {
    test('group_by=tool counts executions per tool', async () => {
      const first = await createHttpTool();
      const second = await createHttpTool();
      await call(first);
      await call(first);
      await call(second);

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/usage/aggregate?project_id=${projectId}&meter_type=tool_execution&group_by=tool`
      );
      expect(res.status).toBe(200);
      const counts = Object.fromEntries(
        res.body.groups.data.map(
          (group: { key: string | null; event_count: number }) => {
            return [group.key, group.event_count];
          }
        )
      );
      expect(counts[first]).toBe(2);
      expect(counts[second]).toBe(1);
    });

    test('tool_id and outcome narrow the rollup and are echoed', async () => {
      const toolId = await createHttpTool('/fail');
      await call(toolId);
      await call(toolId);

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/usage/aggregate?project_id=${projectId}&tool_id=${toolId}&outcome=error`
      );
      expect(res.status).toBe(200);
      expect(res.body.totals.event_count).toBe(2);
      expect(res.body.filters).toMatchObject({
        tool_id: toolId,
        outcome: 'error',
      });

      const ok = await authenticatedTestClient(adminToken).get(
        `/api/v1/usage/aggregate?project_id=${projectId}&tool_id=${toolId}&outcome=ok`
      );
      expect(ok.body.totals.event_count).toBe(0);
    });

    test('a tool_id naming no tool in the project empties the rollup', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/usage/aggregate?project_id=${projectId}&tool_id=tool_doesnotexist`
      );
      expect(res.status).toBe(200);
      expect(res.body.totals.event_count).toBe(0);
    });

    test('include=distinct counts the tools the window touched', async () => {
      const toolId = await createHttpTool();
      await call(toolId);

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/usage/aggregate?project_id=${projectId}&tool_id=${toolId}&include=distinct`
      );
      expect(res.body.totals.distinct.tools).toBe(1);
    });

    test('a user granted usage:GetAggregate reads the tool rollup', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/aggregate?project_id=${projectId}&meter_type=tool_execution&group_by=tool`
      );
      expect(res.status).toBe(200);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/usage/aggregate?project_id=${projectId}&group_by=tool`
      );
      expect(res.status).toBe(401);
    });

    test('a user without usage:GetAggregate returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/usage/aggregate?project_id=${projectId}&group_by=tool`
      );
      expect(res.status).toBe(403);
    });
  });
});
