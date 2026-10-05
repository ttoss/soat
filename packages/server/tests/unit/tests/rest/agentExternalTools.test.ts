import {
  type AgentToolTurn,
  pollUntil,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { offeredSchema, offeredToolNames } from '../../fixtures/scriptedModel';

// An agent's `mcp` and `builtin` bindings expand into one model-visible tool
// per remote tool or action. The MCP server is a path on the recording target
// answering JSON-RPC; builtin actions run in-process under the caller's bearer.

type McpTool = { name: string; inputSchema?: object };

describe('POST /api/v1/agents/:agent_id/generate — mcp and builtin tools', () => {
  let turn: AgentToolTurn;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'externaltools' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  const rpc = (body: Record<string, unknown>, result: object) => {
    return { body: { jsonrpc: '2.0', id: body.id, result } };
  };

  /** An mcp tool backed by a fresh server path that lists `tools`. */
  const mcpTool = async (args: {
    tools?: McpTool[];
    onList?: (body: Record<string, unknown>) => object;
    onCall?: (params: { name: string; arguments: object }) => object;
    tool?: Record<string, unknown>;
  }) => {
    const path = `/${turn.unique('mcp')}`;
    turn.target.reply(path, (body) => {
      if (body.method === 'tools/list') {
        return args.onList?.(body) ?? rpc(body, { tools: args.tools ?? [] });
      }
      if (body.method === 'tools/call' && args.onCall) {
        return args.onCall(body.params as { name: string; arguments: object });
      }
      return rpc(body, { content: [] });
    });
    const tool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${path}` },
      ...args.tool,
    });
    return { ...tool, path };
  };

  const bindAgent = (
    toolIds: string[],
    extra: Record<string, unknown> = {}
  ) => {
    return turn.createAgent({
      tool_bindings: toolIds.map((toolId) => {
        return { tool_id: toolId };
      }),
      ...extra,
    });
  };

  const listing = (prefix: string): McpTool[] => {
    return [{ name: `${prefix}_read` }, { name: `${prefix}_delete` }];
  };

  describe('mcp', () => {
    test('actions and denied_actions narrow what the listing offers', async () => {
      const open = await mcpTool({ tools: listing('open') });
      const allowed = await mcpTool({
        tools: listing('allowed'),
        tool: { actions: ['allowed_read'] },
      });
      const none = await mcpTool({
        tools: listing('none'),
        tool: { actions: [] },
      });
      const denied = await mcpTool({
        tools: listing('denied'),
        tool: { denied_actions: ['denied_delete'] },
      });
      const both = await mcpTool({
        tools: listing('both'),
        tool: {
          actions: ['both_read', 'both_delete'],
          denied_actions: ['both_delete'],
        },
      });
      const agentId = await bindAgent([
        open.id,
        allowed.id,
        none.id,
        denied.id,
        both.id,
      ]);

      await turn.generate({ agentId, calls: [] });

      expect(offeredToolNames(turn.model).sort()).toEqual(
        [
          'allowed_read',
          'both_read',
          'denied_read',
          'open_delete',
          'open_read',
        ].sort()
      );
      // A listed tool with no inputSchema is offered an empty object schema.
      expect(
        offeredSchema({ model: turn.model, toolName: 'open_read' })
      ).toEqual(expect.objectContaining({ type: 'object', properties: {} }));
    });

    test('a tools/call answer becomes the result the model sees', async () => {
      const server = await mcpTool({
        tools: [
          { name: 'json_echo' },
          { name: 'text_echo' },
          { name: 'empty_content' },
          { name: 'dropped' },
        ],
        onCall: (params) => {
          const answers: Record<string, object> = {
            json_echo: { content: [{ text: '{"ok":true}' }] },
            text_echo: { content: [{ text: 'plain text result' }] },
            empty_content: { content: [] },
          };
          if (params.name === 'dropped') return { destroy: true };
          return {
            body: { jsonrpc: '2.0', id: 2, result: answers[params.name] },
          };
        },
      });
      const agentId = await bindAgent([server.id]);

      const { results } = await turn.generate({
        agentId,
        calls: [
          { name: 'json_echo', args: {} },
          { name: 'text_echo', args: {} },
          { name: 'empty_content', args: {} },
          { name: 'dropped', args: {} },
        ],
      });

      expect(results.slice(0, 3)).toEqual([
        { ok: true },
        'plain text result',
        { content: [] },
      ]);
      // A dropped connection fails the call rather than answering for it.
      expect(results[3]).not.toEqual({ content: [] });
      const usage = await turn
        .api()
        .get('/api/v1/usage/events')
        .query({ meter_type: 'tool_execution', tool_id: server.id });
      expect(usage.status).toBe(200);
      expect(
        usage.body.data
          .map((event: { outcome: string }) => {
            return event.outcome;
          })
          .sort()
      ).toEqual(['error', 'ok', 'ok', 'ok']);
    });

    test('a preset is hidden from the listed schema and pinned, a context token retyped to it', async () => {
      const calls: object[] = [];
      const server = await mcpTool({
        tools: [
          {
            name: 'get_account',
            inputSchema: {
              type: 'object',
              properties: {
                adAccountId: { type: 'string' },
                limit: { type: 'integer' },
                query: { type: 'string' },
              },
              required: ['adAccountId', 'query'],
            },
          },
        ],
        onCall: (params) => {
          calls.push(params.arguments);
          return { body: { jsonrpc: '2.0', id: 2, result: { content: [] } } };
        },
        tool: {
          preset_parameters: {
            adAccountId: '{{context:ocaAdAccountId}}',
            limit: '{{context:ocaLimit}}',
          },
        },
      });
      const agentId = await bindAgent([server.id]);

      await turn.generate({
        agentId,
        calls: [
          {
            name: 'get_account',
            args: { adAccountId: 'act_other', query: 'q' },
          },
        ],
        body: { tool_context: { ocaAdAccountId: 'act_9', ocaLimit: '25' } },
      });

      expect(calls).toEqual([{ adAccountId: 'act_9', limit: 25, query: 'q' }]);
      const schema = offeredSchema({
        model: turn.model,
        toolName: 'get_account',
      });
      expect(schema?.properties).toEqual({ query: { type: 'string' } });
      expect(schema?.required).toEqual(['query']);
    });

    test('an SSE-framed listing resolves its tools', async () => {
      const server = await mcpTool({
        onList: (body) => {
          const message = rpc(body, { tools: [{ name: 'sse_search' }] }).body;
          return {
            raw: `event: message\ndata: ${JSON.stringify(message)}\n\n`,
            contentType: 'text/event-stream',
          };
        },
      });
      const agentId = await bindAgent([server.id]);

      await turn.generate({ agentId, calls: [] });

      expect(offeredToolNames(turn.model)).toEqual(['sse_search']);
    });

    // A binding that resolves to nothing leaves a turn that completes with no
    // error and no warning; the feed entry is what tells it from an agent
    // that never had the tool.
    test('a listing that cannot be used is recorded on the activity feed', async () => {
      const rpcError = await mcpTool({
        onList: (body) => {
          return {
            body: {
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32600, message: 'Server not initialized' },
            },
          };
        },
      });
      const noTools = await mcpTool({
        onList: () => {
          return { body: { tools: [{ name: 'search' }] } };
        },
      });
      const empty = await mcpTool({ tools: [] });
      const unreachable = await mcpTool({ tools: [] });
      const noUrl = await turn.createTool({
        type: 'mcp',
        execute: undefined,
        parameters: undefined,
        mcp: {},
      });
      const failing = [rpcError, noTools, empty, unreachable];
      const agentId = await bindAgent([
        ...failing.map((tool) => {
          return tool.id;
        }),
        noUrl.id,
      ]);

      // A connection the server refuses: outbound fetch is the boundary, and a
      // local server can only drop the socket, which surfaces as an error from
      // another realm than the one the resolver checks against.
      const realFetch = global.fetch;
      const refused = jest
        .spyOn(global, 'fetch')
        .mockImplementation((input, init) => {
          return String(input).includes(unreachable.path)
            ? Promise.reject(new Error('connect ECONNREFUSED'))
            : realFetch(input, init);
        });
      const { id } = await turn.generate({ agentId, calls: [] }).finally(() => {
        refused.mockRestore();
      });

      expect(offeredToolNames(turn.model)).toEqual([]);
      const entries = await pollUntil({
        read: async () => {
          const res = await turn.api().get('/api/v1/activity').query({
            project_id: turn.projectId,
            kind: 'tool_resolution_failed',
            generation_id: id,
          });
          expect(res.status).toBe(200);
          return res.body.data as Array<{
            ref_id: string;
            severity: string;
            detail: { tool_type: string; reason: string };
          }>;
        },
        done: (found) => {
          return found.length >= failing.length;
        },
      });
      const reasonOf = (toolId: string) => {
        return entries.find((entry) => {
          return entry.ref_id === toolId;
        })?.detail.reason;
      };
      expect(entries).toHaveLength(failing.length);
      expect(entries[0]).toMatchObject({
        severity: 'warning',
        detail: expect.objectContaining({ tool_type: 'mcp' }),
      });
      expect(reasonOf(rpcError.id)).toContain('Server not initialized');
      expect(reasonOf(noTools.id)).toContain('result.tools');
      expect(reasonOf(empty.id)).toContain('tools/list returned no tools');
      expect(reasonOf(unreachable.id)).toBe('connect ECONNREFUSED');
    });
  });

  describe('builtin', () => {
    const builtinTool = (extra: Record<string, unknown>) => {
      return turn.createTool({
        type: 'builtin',
        execute: undefined,
        parameters: undefined,
        ...extra,
      });
    };

    test('an action runs in-process and returns the platform response', async () => {
      const tool = await builtinTool({ actions: ['list-files'] });
      const agentId = await bindAgent([tool.id]);

      const { results } = await turn.generate({
        agentId,
        calls: [{ name: `${tool.name}_list-files`, args: {} }],
      });

      expect(Array.isArray(results[0].data)).toBe(true);
    });

    test('a builtin tool that names no actions offers nothing', async () => {
      const tool = await builtinTool({});
      const agentId = await bindAgent([tool.id]);

      await turn.generate({ agentId, calls: [] });

      expect(offeredToolNames(turn.model)).toEqual([]);
    });

    // Evaluated against the action's IAM permission, not the tool's action
    // name, which no `module:Operation` pattern can match.
    test("the agent's boundary_policy denies an action it does not allow", async () => {
      const tool = await builtinTool({ actions: ['list-files'] });
      const agentId = await bindAgent([tool.id], {
        boundary_policy: {
          statement: [{ effect: 'Deny', action: ['files:GetFile'] }],
        },
      });

      const { results } = await turn.generate({
        agentId,
        calls: [{ name: `${tool.name}_list-files`, args: {} }],
      });

      expect(results).toEqual([
        { error: 'Forbidden: boundary policy denies files:GetFile' },
      ]);
    });

    test("the agent's boundary_policy lets an allowed action run", async () => {
      const tool = await builtinTool({ actions: ['list-files'] });
      const agentId = await bindAgent([tool.id], {
        boundary_policy: {
          statement: [
            { effect: 'Allow', action: ['files:GetFile'], resource: ['*'] },
          ],
        },
      });

      const { results } = await turn.generate({
        agentId,
        calls: [{ name: `${tool.name}_list-files`, args: {} }],
      });

      expect(Array.isArray(results[0].data)).toBe(true);
    });

    test('a preset is hidden from the action schema and pinned over the model value', async () => {
      const target = await builtinTool({ actions: ['list-files'] });
      const decoy = await builtinTool({ actions: ['list-files'] });
      const pinned = await builtinTool({
        actions: ['get-tool'],
        preset_parameters: { tool_id: target.id },
      });
      const agentId = await bindAgent([pinned.id]);
      const action = `${pinned.name}_get-tool`;

      const { results } = await turn.generate({
        agentId,
        calls: [{ name: action, args: { tool_id: decoy.id } }],
      });

      expect(results[0]).toMatchObject({ id: target.id, name: target.name });
      expect(
        offeredSchema({ model: turn.model, toolName: action })?.properties
      ).not.toHaveProperty('tool_id');
    });
  });
});
