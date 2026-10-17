import { drainQueueOnce } from 'src/lib/orchestrationWorker';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient } from '../../testClient';

/**
 * A request's `X-Request-Id` reaches the server an `http` or `mcp` tool calls,
 * so a receiver's log line and the runtime's name the same request. Work no
 * request started runs under an id of its own.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Request correlation', () => {
  let turn: AgentToolTurn;

  const rpc = (body: Record<string, unknown>, result: object) => {
    return { body: { jsonrpc: '2.0', id: body.id, result } };
  };

  /** An mcp tool on a fresh target path that lists one tool, `echo`. */
  const mcpTool = async (headers?: Record<string, string>) => {
    const path = `/${turn.unique('mcp')}`;
    turn.target.reply(path, (body) => {
      if (body.method === 'tools/list') {
        return rpc(body, { tools: [{ name: 'echo' }] });
      }
      return rpc(body, { content: [{ type: 'text', text: '{"ok":true}' }] });
    });
    const created = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${path}`, headers },
    });
    return { ...created, path };
  };

  const callEcho = (toolId: string) => {
    return authenticatedTestClient(turn.adminToken)
      .post(`/api/v1/tools/${toolId}/call`)
      .send({ action: 'echo', input: {} });
  };

  const requestIdsAt = (path: string) => {
    return turn.target.requestsAt(path).map((request) => {
      return request.headers['x-request-id'];
    });
  };

  /** An http tool posting to its own path on the target. */
  const httpTool = async (headers?: Record<string, string>) => {
    const name = turn.unique('http');
    turn.target.reply(`/${name}`, () => {
      return { body: { ok: true } };
    });
    const created = await turn.createTool({
      name,
      execute: {
        url: `${turn.target.baseUrl}/${name}`,
        method: 'POST',
        headers,
      },
    });
    return { ...created, path: `/${name}` };
  };

  const callHttp = (toolId: string) => {
    return authenticatedTestClient(turn.adminToken)
      .post(`/api/v1/tools/${toolId}/call`)
      .send({ input: { amount: 1 } });
  };

  const savedWorkerDisabled = process.env.ORCHESTRATION_WORKER_DISABLED;

  beforeAll(async () => {
    process.env.ORCHESTRATION_WORKER_DISABLED = 'true';
    turn = await startAgentToolTurn({ prefix: 'reqcorrelation' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    if (savedWorkerDisabled === undefined) {
      delete process.env.ORCHESTRATION_WORKER_DISABLED;
    } else {
      process.env.ORCHESTRATION_WORKER_DISABLED = savedWorkerDisabled;
    }
    await turn.close();
  });

  describe('POST /api/v1/tools/:tool_id/call — mcp', () => {
    test("every request the call sends carries the caller's X-Request-Id", async () => {
      const tool = await mcpTool();

      const res = await callEcho(tool.id).set('X-Request-Id', 'req-call-1');

      expect(res.status).toBe(200);
      expect(requestIdsAt(tool.path)).toEqual(['req-call-1', 'req-call-1']);
    });

    test('without one, the id the response echoes is the one sent', async () => {
      const tool = await mcpTool();

      const res = await callEcho(tool.id);

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(requestIdsAt(tool.path)).toEqual([
        res.headers['x-request-id'],
        res.headers['x-request-id'],
      ]);
    });

    test('a header the tool defines under that name is kept', async () => {
      const tool = await mcpTool({ 'x-request-id': 'tool-own-id' });

      await callEcho(tool.id).set('X-Request-Id', 'req-call-2');

      expect(requestIdsAt(tool.path)).toEqual(['tool-own-id', 'tool-own-id']);
    });
  });

  describe('POST /api/v1/tools/:tool_id/call — http', () => {
    test("the request carries the caller's X-Request-Id", async () => {
      const tool = await httpTool();

      const res = await callHttp(tool.id).set('X-Request-Id', 'req-http-1');

      expect(res.status).toBe(200);
      expect(requestIdsAt(tool.path)).toEqual(['req-http-1']);
    });

    test('a header the tool defines under that name is kept', async () => {
      const tool = await httpTool({ 'X-Request-ID': 'tool-own-id' });

      await callHttp(tool.id).set('X-Request-Id', 'req-http-2');

      expect(requestIdsAt(tool.path)).toEqual(['tool-own-id']);
    });
  });

  describe('POST /api/v1/orchestration-runs — drained by the worker', () => {
    test('the tool request carries an id of its own, not the starting request’s', async () => {
      const tool = await httpTool();
      const orchestration = await authenticatedTestClient(turn.adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: turn.projectId,
          name: turn.unique('orch'),
          nodes: [
            {
              id: 'act',
              type: 'tool',
              tool_id: tool.id,
              input_mapping: { amount: 1 },
            },
          ],
          edges: [],
        });
      expect(orchestration.status).toBe(201);

      const run = await authenticatedTestClient(turn.adminToken)
        .post('/api/v1/orchestration-runs')
        .set('X-Request-Id', 'req-start-1')
        .send({
          orchestration_id: orchestration.body.id,
          input: {},
          wait: false,
        });
      expect(run.status).toBe(201);
      expect(await drainQueueOnce()).toBe(1);

      const [sent] = requestIdsAt(tool.path);
      expect(sent).toMatch(UUID);
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate — mcp binding', () => {
    test('the listing and the call the model makes carry the id', async () => {
      const tool = await mcpTool();
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });

      const res = await authenticatedTestClient(turn.adminToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .set('X-Request-Id', 'req-generate-1')
        .send({ messages: [proposeCalls([{ name: 'echo', args: {} }])] });

      expect(res.status).toBe(200);
      expect(requestIdsAt(tool.path)).toEqual([
        'req-generate-1',
        'req-generate-1',
      ]);
    });
  });

  describe('X-Request-Id', () => {
    test.each([
      ['longer than 128 characters', 'a'.repeat(129)],
      ['carrying a character outside the token set', 'req id with spaces'],
    ])('an id %s is replaced by a fresh one', async (_label, sent) => {
      const tool = await mcpTool();

      const res = await callEcho(tool.id).set('X-Request-Id', sent);

      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(requestIdsAt(tool.path)).toEqual([
        res.headers['x-request-id'],
        res.headers['x-request-id'],
      ]);
    });
  });
});
