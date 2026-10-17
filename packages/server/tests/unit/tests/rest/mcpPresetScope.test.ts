import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient } from '../../testClient';

/**
 * A preset on an `mcp` tool reaches each action whose input schema declares
 * it, and no other: a server that validates its arguments refuses a key its
 * action does not take, so a preset meant for one action would break the rest.
 */

describe('mcp preset scope', () => {
  let turn: AgentToolTurn;

  const rpc = (body: Record<string, unknown>, result: object) => {
    return { body: { jsonrpc: '2.0', id: body.id, result } };
  };

  /** A server listing `search` (takes `folder`), `fetch` (does not) and `ping` (no schema). */
  const mcpTool = async (
    presets: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => {
    const path = `/${turn.unique('mcp')}`;
    turn.target.reply(path, (body) => {
      if (body.method === 'tools/list') {
        return rpc(body, {
          tools: [
            {
              name: 'search',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  folder: { type: 'string' },
                },
              },
            },
            {
              name: 'fetch',
              inputSchema: {
                type: 'object',
                properties: { id: { type: 'string' } },
                additionalProperties: false,
              },
            },
            { name: 'ping' },
          ],
        });
      }
      return rpc(body, { content: [{ type: 'text', text: '{"ok":true}' }] });
    });
    const created = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${path}` },
      preset_parameters: presets,
      ...extra,
    });
    return { ...created, path };
  };

  const call = (args: {
    toolId: string;
    action: string;
    input: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(turn.adminToken)
      .post(`/api/v1/tools/${args.toolId}/call`)
      .send({ action: args.action, input: args.input });
  };

  /** The arguments each `tools/call` carried, by the tool it named. */
  const sentArguments = (path: string) => {
    return turn.target
      .requestsAt(path)
      .filter((request) => {
        return request.body.method === 'tools/call';
      })
      .map((request) => {
        const params = request.body.params as {
          name: string;
          arguments: Record<string, unknown>;
        };
        return { name: params.name, arguments: params.arguments };
      });
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'mcppresetscope' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  describe('POST /api/v1/tools/:tool_id/call', () => {
    test('an action whose schema declares the preset receives it', async () => {
      const tool = await mcpTool({ folder: '/pinned' });

      const res = await call({
        toolId: tool.id,
        action: 'search',
        input: { query: 'q', folder: '/caller' },
      });

      expect(res.status).toBe(200);
      expect(sentArguments(tool.path)).toEqual([
        { name: 'search', arguments: { query: 'q', folder: '/pinned' } },
      ]);
    });

    test('an action whose schema does not declare it is sent without it', async () => {
      const tool = await mcpTool({ folder: '/pinned' });

      const res = await call({
        toolId: tool.id,
        action: 'fetch',
        input: { id: 'doc_1' },
      });

      expect(res.status).toBe(200);
      expect(sentArguments(tool.path)).toEqual([
        { name: 'fetch', arguments: { id: 'doc_1' } },
      ]);
    });

    test('an action that publishes no schema receives every preset', async () => {
      const tool = await mcpTool({ folder: '/pinned' });

      const res = await call({ toolId: tool.id, action: 'ping', input: {} });

      expect(res.status).toBe(200);
      expect(sentArguments(tool.path)).toEqual([
        { name: 'ping', arguments: { folder: '/pinned' } },
      ]);
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate — mcp binding', () => {
    test('each call the model makes carries only the presets its action declares', async () => {
      const tool = await mcpTool({ folder: '/pinned' });
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });

      await turn.generate({
        agentId,
        calls: [
          { name: 'search', args: { query: 'q' } },
          { name: 'fetch', args: { id: 'doc_1' } },
        ],
      });

      expect(sentArguments(tool.path)).toEqual(
        expect.arrayContaining([
          { name: 'search', arguments: { query: 'q', folder: '/pinned' } },
          { name: 'fetch', arguments: { id: 'doc_1' } },
        ])
      );
      expect(sentArguments(tool.path)).toHaveLength(2);
    });
  });
  /**
   * A guardrail judges the call that goes out, so it sees the presets the
   * action takes and no other. This one lets a call through only when it
   * carries no `folder`.
   */
  describe('guardrails', () => {
    const noFolder = { class: 'B', guard: { '!': { var: 'args.folder' } } };

    const gatedMcpTool = async () => {
      return mcpTool(
        { folder: '/pinned' },
        { guardrail_ids: [await turn.createGuardrail(noFolder)] }
      );
    };

    test('a direct call of an action without the preset is judged without it', async () => {
      const tool = await gatedMcpTool();

      const res = await call({
        toolId: tool.id,
        action: 'fetch',
        input: { id: 'doc_1' },
      });

      expect(res.status).toBe(200);
      expect(sentArguments(tool.path)).toEqual([
        { name: 'fetch', arguments: { id: 'doc_1' } },
      ]);
    });

    test('a direct call of an action with the preset is judged with it', async () => {
      const tool = await gatedMcpTool();

      const res = await call({
        toolId: tool.id,
        action: 'search',
        input: { query: 'q' },
      });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('TOOL_DISPATCH_FAILED');
      expect(sentArguments(tool.path)).toEqual([]);
    });

    test('a call the model makes is judged on the presets its action takes', async () => {
      const tool = await gatedMcpTool();
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });

      await turn.generate({
        agentId,
        calls: [
          { name: 'search', args: { query: 'q' } },
          { name: 'fetch', args: { id: 'doc_1' } },
        ],
      });

      expect(sentArguments(tool.path)).toEqual([
        { name: 'fetch', arguments: { id: 'doc_1' } },
      ]);
    });
  });
});
