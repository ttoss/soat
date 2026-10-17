import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient } from '../../testClient';

/**
 * A tool's `output_mapping` reads the action that ran as `action`, so one
 * mapping can reshape each action of an `mcp` or `builtin` tool its own way.
 */

const BY_ACTION = {
  action: { var: 'action' },
  ok: { var: 'output.ok' },
};

describe('output_mapping action', () => {
  let turn: AgentToolTurn;

  const rpc = (body: Record<string, unknown>, result: object) => {
    return { body: { jsonrpc: '2.0', id: body.id, result } };
  };

  const mcpTool = async () => {
    const path = `/${turn.unique('mcp')}`;
    turn.target.reply(path, (body) => {
      if (body.method === 'tools/list') {
        return rpc(body, { tools: [{ name: 'search' }, { name: 'fetch' }] });
      }
      return rpc(body, { content: [{ type: 'text', text: '{"ok":true}' }] });
    });
    return turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${path}` },
      output_mapping: BY_ACTION,
    });
  };

  const call = (args: {
    toolId: string;
    action?: string;
    input: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(turn.adminToken)
      .post(`/api/v1/tools/${args.toolId}/call`)
      .send({ action: args.action, input: args.input });
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'outmapaction' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  describe('POST /api/v1/tools/:tool_id/call', () => {
    test.each(['search', 'fetch'])(
      'an mcp tool maps %s under its own name',
      async (action) => {
        const tool = await mcpTool();

        const res = await call({ toolId: tool.id, action, input: {} });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ action, ok: true });
      }
    );

    test('an http tool has no action to read', async () => {
      const name = turn.unique('http');
      turn.target.reply(`/${name}`, () => {
        return { body: { ok: true } };
      });
      const tool = await turn.createTool({ name, output_mapping: BY_ACTION });

      const res = await call({ toolId: tool.id, input: { amount: 1 } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ action: null, ok: true });
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate — mcp binding', () => {
    test('each call the model makes is mapped under its own action', async () => {
      const tool = await mcpTool();
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });

      const { results } = await turn.generate({
        agentId,
        calls: [
          { name: 'search', args: {} },
          { name: 'fetch', args: {} },
        ],
      });

      expect(results).toEqual([
        { action: 'search', ok: true },
        { action: 'fetch', ok: true },
      ]);
    });
  });
});
