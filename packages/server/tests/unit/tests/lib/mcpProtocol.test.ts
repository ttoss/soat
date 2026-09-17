import { asSchema } from 'ai';
import { resolveMcpTools } from 'src/lib/agentToolResolverMcp';
import { McpToolError } from 'src/lib/mcpProtocol';

/**
 * How much of the MCP protocol an `mcp` binding actually reads.
 *
 * Direct rather than through a generation: each property here is a branch of
 * one JSON-RPC answer, and provoking twelve distinct server answers through a
 * model turn would test the turn, not the reading.
 */
describe('MCP protocol fidelity', () => {
  const MCP_URL = 'http://localhost:19999/mcp';

  const jsonResponse = (body: unknown) => {
    return new Response(JSON.stringify(body), { status: 200 });
  };

  /** Answers `tools/list` from `pages` in order, `tools/call` from `call`. */
  const stubMcpServer = (args: {
    pages?: Array<Record<string, unknown>>;
    call?: unknown;
  }) => {
    const listCursors: Array<string | undefined> = [];
    let page = 0;
    jest
      .spyOn(global, 'fetch')
      .mockImplementation((_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          method: string;
          params?: { cursor?: string };
        };
        if (body.method === 'tools/list') {
          listCursors.push(body.params?.cursor);
          const result = args.pages?.[page] ?? { tools: [] };
          page += 1;
          return Promise.resolve(jsonResponse({ result }));
        }
        return Promise.resolve(jsonResponse(args.call ?? { result: {} }));
      });
    return { listCursors };
  };

  const resolve = async () => {
    return resolveMcpTools({
      typedTool: { mcp: { url: MCP_URL } },
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });
  };

  const executeOnly = async (tools: Awaited<ReturnType<typeof resolve>>) => {
    const [entry] = Object.values(tools);
    if (!entry?.execute) throw new Error('resolved tool has no execute');
    return entry.execute({}, {} as never);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('tools/list pagination', () => {
    test('follows nextCursor until the catalogue is exhausted', async () => {
      const { listCursors } = stubMcpServer({
        pages: [
          { tools: [{ name: 'page_one' }], nextCursor: 'c1' },
          { tools: [{ name: 'page_two' }], nextCursor: 'c2' },
          { tools: [{ name: 'page_three' }] },
        ],
      });

      const result = await resolve();

      expect(Object.keys(result).sort()).toEqual([
        'page_one',
        'page_three',
        'page_two',
      ]);
      expect(listCursors).toEqual([undefined, 'c1', 'c2']);
    });

    test('stops on a cursor it has already followed', async () => {
      const { listCursors } = stubMcpServer({
        pages: [
          { tools: [{ name: 'first' }], nextCursor: 'loop' },
          { tools: [{ name: 'second' }], nextCursor: 'loop' },
        ],
      });

      const result = await resolve();

      expect(Object.keys(result).sort()).toEqual(['first', 'second']);
      expect(listCursors).toEqual([undefined, 'loop']);
    });

    test('reports a page that fails after an earlier page succeeded', async () => {
      const reportResolutionFailure = jest.fn();
      let page = 0;
      jest.spyOn(global, 'fetch').mockImplementation(() => {
        page += 1;
        return Promise.resolve(
          page === 1
            ? jsonResponse({
                result: { tools: [{ name: 'first' }], nextCursor: 'c1' },
              })
            : new Response('nope', { status: 500 })
        );
      });

      const result = await resolveMcpTools({
        typedTool: { mcp: { url: MCP_URL } },
        buildContextHeaders: () => {
          return {};
        },
        logToolCallingError: jest.fn(),
        reportResolutionFailure,
      });

      // A partial catalogue is a turn missing tools, so it is a failed
      // resolution rather than a smaller surface.
      expect(Object.keys(result)).toHaveLength(0);
      expect(reportResolutionFailure).toHaveBeenCalledWith({
        reason: 'tools/list answered 500',
      });
    });
  });

  describe('tools/list fidelity', () => {
    test('carries title, annotations, _meta and outputSchema onto the tool', async () => {
      stubMcpServer({
        pages: [
          {
            tools: [
              {
                name: 'delete_everything',
                title: 'Delete Everything',
                description: 'Removes it all',
                inputSchema: { type: 'object', properties: {} },
                outputSchema: {
                  type: 'object',
                  properties: { deleted: { type: 'integer' } },
                },
                annotations: { destructiveHint: true, readOnlyHint: false },
                _meta: { source: 'vendor' },
              },
            ],
          },
        ],
      });

      const result = await resolve();
      const entry = result.delete_everything;

      expect(entry.title).toBe('Delete Everything');
      expect(entry.metadata).toEqual({
        annotations: { destructiveHint: true, readOnlyHint: false },
        meta: { source: 'vendor' },
      });
      expect(await asSchema(entry.outputSchema!).jsonSchema).toEqual({
        type: 'object',
        properties: { deleted: { type: 'integer' } },
      });
    });

    test('leaves the extras off a tool that declares none', async () => {
      stubMcpServer({ pages: [{ tools: [{ name: 'plain' }] }] });

      const entry = (await resolve()).plain;

      expect(entry.title).toBeUndefined();
      expect(entry.metadata).toBeUndefined();
      expect(entry.outputSchema).toBeUndefined();
    });

    test('skips a listing entry that names no tool', async () => {
      stubMcpServer({
        pages: [{ tools: [{ description: 'nameless' }, { name: 'real' }] }],
      });

      expect(Object.keys(await resolve())).toEqual(['real']);
    });
  });

  describe('tools/call failures', () => {
    test('an isError result fails the tool call', async () => {
      stubMcpServer({
        pages: [{ tools: [{ name: 'flaky' }] }],
        call: {
          result: {
            isError: true,
            content: [{ type: 'text', text: 'upstream rate limit' }],
          },
        },
      });

      const tools = await resolve();

      await expect(executeOnly(tools)).rejects.toThrow(McpToolError);
      await expect(executeOnly(tools)).rejects.toThrow(/upstream rate limit/);
    });

    test('an isError result reaches logToolCallingError', async () => {
      const logToolCallingError = jest.fn();
      stubMcpServer({
        pages: [{ tools: [{ name: 'flaky' }] }],
        call: { result: { isError: true, content: [] } },
      });

      const tools = await resolveMcpTools({
        typedTool: { mcp: { url: MCP_URL } },
        buildContextHeaders: () => {
          return {};
        },
        logToolCallingError,
      });
      await expect(executeOnly(tools)).rejects.toThrow(McpToolError);

      expect(logToolCallingError).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'flaky', toolType: 'mcp' })
      );
    });

    test('a JSON-RPC error member fails the tool call', async () => {
      stubMcpServer({
        pages: [{ tools: [{ name: 'refused' }] }],
        call: { error: { code: -32602, message: 'Invalid params' } },
      });

      const tools = await resolve();

      // Before, the whole envelope came back as the tool's result and the model
      // read a protocol refusal as an answer.
      await expect(executeOnly(tools)).rejects.toThrow(
        /-32602: Invalid params/
      );
    });
  });

  describe('tools/call results', () => {
    test('prefers structuredContent over the text block beside it', async () => {
      stubMcpServer({
        pages: [{ tools: [{ name: 'structured' }] }],
        call: {
          result: {
            structuredContent: { total: 7 },
            content: [{ type: 'text', text: '{"total":"seven-ish"}' }],
          },
        },
      });

      await expect(executeOnly(await resolve())).resolves.toEqual({ total: 7 });
    });

    test('joins every text block, not just the first', async () => {
      stubMcpServer({
        pages: [{ tools: [{ name: 'chunked' }] }],
        call: {
          result: {
            content: [
              { type: 'text', text: 'first half' },
              { type: 'text', text: 'second half' },
            ],
          },
        },
      });

      await expect(executeOnly(await resolve())).resolves.toBe(
        'first half\nsecond half'
      );
    });

    test('parses a single JSON text block', async () => {
      stubMcpServer({
        pages: [{ tools: [{ name: 'jsonish' }] }],
        call: { result: { content: [{ type: 'text', text: '{"ok":true}' }] } },
      });

      await expect(executeOnly(await resolve())).resolves.toEqual({ ok: true });
    });

    test('hands over the blocks when one is not text', async () => {
      const content = [
        { type: 'text', text: 'see the chart' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      ];
      stubMcpServer({
        pages: [{ tools: [{ name: 'mixed' }] }],
        call: { result: { content } },
      });

      // Flattening to the text block would drop the image silently.
      await expect(executeOnly(await resolve())).resolves.toEqual(content);
    });

    test('returns the result, not the JSON-RPC envelope, when there is no content', async () => {
      stubMcpServer({
        pages: [{ tools: [{ name: 'empty' }] }],
        call: { jsonrpc: '2.0', id: 2, result: { content: [] } },
      });

      await expect(executeOnly(await resolve())).resolves.toEqual({
        content: [],
      });
    });
  });
});
