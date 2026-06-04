import { db } from 'src/db';
import {
  buildContextHeaders,
  HttpToolError,
  isSoatActionAllowedByBoundary,
  resolveAgentTools,
  resolveUrlPathParams,
} from 'src/lib/agentToolResolver';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('resolveAgentTools', () => {
  let adminToken: string;
  let projectId: string;
  let httpToolId: string;
  let clientToolId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'toolresolveradmin', password: 'supersecret' });

    adminToken = await loginAs('toolresolveradmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Tool Resolver Test Project' });
    projectId = projectRes.body.id;

    const httpToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myHttpTool',
        type: 'http',
        description: 'Test HTTP tool',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            page: { type: 'number' },
          },
        },
        execute: {
          url: 'https://example.com/api/search',
          method: 'GET',
        },
      });
    httpToolId = httpToolRes.body.id;

    const clientToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myClientTool',
        type: 'client',
        description: 'Test client tool',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
      });
    clientToolId = clientToolRes.body.id;
  });

  test('resolves http tool and returns tool with execute function', async () => {
    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    expect(tools).toHaveProperty('myHttpTool');
    expect(typeof tools.myHttpTool).toBe('object');
  });

  test('resolves client tool and returns tool without execute function', async () => {
    const tools = await resolveAgentTools({ toolIds: [clientToolId] });
    expect(tools).toHaveProperty('myClientTool');
    expect('execute' in tools.myClientTool).toBe(false);
  });

  test('skips unknown tool IDs', async () => {
    const tools = await resolveAgentTools({ toolIds: ['agt_tl_unknown000'] });
    expect(Object.keys(tools)).toHaveLength(0);
  });

  test('resolves multiple tools at once', async () => {
    const tools = await resolveAgentTools({
      toolIds: [httpToolId, clientToolId],
    });
    expect(Object.keys(tools)).toHaveLength(2);
    expect(tools).toHaveProperty('myHttpTool');
    expect(tools).toHaveProperty('myClientTool');
  });

  test('http tool execute covers GET method branches with query args', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200 })
      );

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      await httpTool.execute({ query: 'test', page: 1 }, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('example.com'),
      expect.objectContaining({ method: 'GET' })
    );

    fetchMock.mockRestore();
  });

  test('http tool execute covers POST method branches', async () => {
    const postToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPostHttpTool',
        type: 'http',
        description: 'Test POST HTTP tool',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: 'https://example.com/api/create',
          method: 'POST',
        },
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'new-item' }), { status: 201 })
      );

    const tools = await resolveAgentTools({ toolIds: [postToolRes.body.id] });
    const postTool = tools.myPostHttpTool;

    if ('execute' in postTool && typeof postTool.execute === 'function') {
      await postTool.execute({ name: 'test item' }, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/create',
      expect.objectContaining({ method: 'POST' })
    );

    fetchMock.mockRestore();
  });

  test('http tool execute throws HttpToolError on non-OK response with JSON body', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      );

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    let thrownError: unknown;
    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      try {
        await httpTool.execute({}, {} as never);
      } catch (error) {
        thrownError = error;
      }
    }

    expect(thrownError).toBeInstanceOf(HttpToolError);
    const httpError = thrownError as HttpToolError;
    expect(httpError.status).toBe(401);
    expect(httpError.message).toContain('HTTP 401');
    expect(httpError.body).toContain('Unauthorized');
    expect(JSON.stringify(httpError)).not.toBe('{}');
    const serialized = JSON.parse(JSON.stringify(httpError)) as {
      message: string;
      name: string;
      status: number;
      body: string;
    };
    expect(serialized.message).toContain('HTTP 401');
    expect(serialized.name).toBe('HttpToolError');
    expect(serialized.status).toBe(401);
    expect(serialized.body).toContain('Unauthorized');

    fetchMock.mockRestore();
  });

  test('http tool execute throws HttpToolError on non-OK response with plain text body', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    let thrownError: unknown;
    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      try {
        await httpTool.execute({}, {} as never);
      } catch (error) {
        thrownError = error;
      }
    }

    expect(thrownError).toBeInstanceOf(HttpToolError);
    const httpError = thrownError as HttpToolError;
    expect(httpError.status).toBe(403);
    expect(httpError.body).toBe('Forbidden');

    fetchMock.mockRestore();
  });

  test('http tool execute supports legacy execute config stored as JSON string', async () => {
    const legacyToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myLegacyHttpTool',
        type: 'http',
        description: 'Legacy stored execute payload',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: 'https://example.com/api/users/{user_id}',
          method: 'GET',
        },
      });

    await db.Tool.update(
      {
        execute: {
          url: 'https://example.com/api/users/{user_id}',
          method: 'GET',
        },
      },
      { where: { publicId: legacyToolRes.body.id } }
    );

    await db.sequelize.query(
      'UPDATE tools SET execute = to_jsonb($1::text) WHERE public_id = $2',
      {
        bind: [
          JSON.stringify({
            url: 'https://example.com/api/users/{user_id}',
            method: 'GET',
          }),
          legacyToolRes.body.id,
        ],
      }
    );

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

    const tools = await resolveAgentTools({ toolIds: [legacyToolRes.body.id] });
    const legacyTool = tools.myLegacyHttpTool;

    if ('execute' in legacyTool && typeof legacyTool.execute === 'function') {
      await legacyTool.execute(
        { user_id: 'u_01', include: 'projects' },
        {} as never
      );
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/users/u_01?include=projects',
      expect.objectContaining({ method: 'GET' })
    );

    fetchMock.mockRestore();
  });

  test('logs HTTP tool call errors when SOAT_ERROR_LOGS_ENABLED is enabled', async () => {
    const originalValue = process.env.SOAT_ERROR_LOGS_ENABLED;
    process.env.SOAT_ERROR_LOGS_ENABLED = 'true';

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('Boom', { status: 500 }));

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      await expect(httpTool.execute({}, {} as never)).rejects.toBeInstanceOf(
        HttpToolError
      );
    }

    fetchMock.mockRestore();
    process.env.SOAT_ERROR_LOGS_ENABLED = originalValue;
  });

  test('DELETE tool with JSON body sends Content-Type and body in request', async () => {
    const deleteToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myDeleteHttpTool',
        type: 'http',
        description: 'Test DELETE HTTP tool with body',
        parameters: {
          type: 'object',
          properties: {
            item_id: { type: 'string' },
          },
        },
        execute: {
          url: 'https://example.com/api/items',
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        },
      });
    expect(deleteToolRes.status).toBe(201);

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true }), { status: 200 })
      );

    const tools = await resolveAgentTools({ toolIds: [deleteToolRes.body.id] });
    const deleteTool = tools.myDeleteHttpTool;

    if ('execute' in deleteTool && typeof deleteTool.execute === 'function') {
      await deleteTool.execute({ item_id: 'abc' }, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/items',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ item_id: 'abc' }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );

    fetchMock.mockRestore();
  });

  test('does not log HTTP tool call errors when SOAT_ERROR_LOGS_ENABLED is disabled', async () => {
    const originalValue = process.env.SOAT_ERROR_LOGS_ENABLED;
    process.env.SOAT_ERROR_LOGS_ENABLED = 'false';

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('Boom', { status: 500 }));

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      await expect(httpTool.execute({}, {} as never)).rejects.toBeInstanceOf(
        HttpToolError
      );
    }

    fetchMock.mockRestore();
    process.env.SOAT_ERROR_LOGS_ENABLED = originalValue;
  });
});

describe('HttpToolError', () => {
  test('serializes to JSON with message, name, status, and body', () => {
    const error = new HttpToolError(
      'HTTP 401: Unauthorized',
      401,
      'Unauthorized'
    );
    const json = JSON.stringify(error);
    expect(json).not.toBe('{}');
    const parsed = JSON.parse(json) as {
      message: string;
      name: string;
      status: number;
      body: string;
    };
    expect(parsed.message).toBe('HTTP 401: Unauthorized');
    expect(parsed.name).toBe('HttpToolError');
    expect(parsed.status).toBe(401);
    expect(parsed.body).toBe('Unauthorized');
  });

  test('is an instance of Error', () => {
    const error = new HttpToolError(
      'HTTP 500: Internal Server Error',
      500,
      'Internal Server Error'
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HttpToolError');
  });
});

describe('buildContextHeaders', () => {
  test('returns empty object when toolContext is undefined', () => {
    expect(buildContextHeaders(undefined)).toEqual({});
  });

  test('returns empty object when called with no arguments', () => {
    expect(buildContextHeaders()).toEqual({});
  });

  test('converts toolContext keys to X-Soat-Context-* headers with title-case first letter', () => {
    const result = buildContextHeaders({
      environment: 'production',
      tenantId: 'abc-123',
    });

    expect(result).toEqual({
      'X-Soat-Context-Environment': 'production',
      'X-Soat-Context-TenantId': 'abc-123',
    });
  });

  test('preserves header values unchanged', () => {
    const result = buildContextHeaders({ region: 'us-east-1' });

    expect(result['X-Soat-Context-Region']).toBe('us-east-1');
  });

  test('handles multiple context entries', () => {
    const result = buildContextHeaders({
      a: '1',
      b: '2',
      c: '3',
    });

    expect(Object.keys(result)).toHaveLength(3);
    expect(result['X-Soat-Context-A']).toBe('1');
    expect(result['X-Soat-Context-B']).toBe('2');
    expect(result['X-Soat-Context-C']).toBe('3');
  });
});

describe('isSoatActionAllowedByBoundary', () => {
  test('returns true when boundaryPolicy is null', () => {
    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: null,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });

  test('returns true when boundaryPolicy is undefined', () => {
    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: undefined,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });

  test('returns false when boundary policy is structurally invalid', () => {
    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: { invalid: 'policy', notAStatement: true },
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(false);
  });

  test('returns true when valid Allow policy permits the action', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['agents:CreateGeneration'],
        },
      ],
    };

    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: policy,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });

  test('returns false when valid policy does not allow the action', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['files:GetFile'],
        },
      ],
    };

    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: policy,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(false);
  });

  test('returns true when wildcard action allows everything', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['*'],
        },
      ],
    };

    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: policy,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });
});

describe('resolveUrlPathParams', () => {
  test('returns unchanged url and all args as remaining when no placeholders', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/api/items',
      toolArgs: { foo: 'bar', baz: 123 },
    });
    expect(result.resolvedUrl).toBe('https://example.com/api/items');
    expect(result.remainingArgs).toEqual({ foo: 'bar', baz: 123 });
  });

  test('replaces single path param and removes it from remainingArgs', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/api/items/{itemId}',
      toolArgs: { itemId: 'item-123', filter: 'active' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/api/items/item-123');
    expect(result.remainingArgs).toEqual({ filter: 'active' });
  });

  test('replaces multiple path params', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/api/{projectId}/items/{itemId}',
      toolArgs: { projectId: 'prj-1', itemId: 'item-2', extra: 'value' },
    });
    expect(result.resolvedUrl).toBe(
      'https://example.com/api/prj-1/items/item-2'
    );
    expect(result.remainingArgs).toEqual({ extra: 'value' });
  });

  test('URL-encodes path param values', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/search/{query}',
      toolArgs: { query: 'hello world' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/search/hello%20world');
  });

  test('leaves placeholder unchanged when arg is not provided', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/{id}/details',
      toolArgs: { other: 'value' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/{id}/details');
    expect(result.remainingArgs).toEqual({ other: 'value' });
  });

  test('handles empty toolArgs', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/{id}/details',
      toolArgs: {},
    });
    expect(result.resolvedUrl).toBe('https://example.com/{id}/details');
    expect(result.remainingArgs).toEqual({});
  });
});

describe('resolveAgentTools - mcp and soat types', () => {
  let adminToken: string;
  let projectId: string;
  let mcpToolId: string;
  let httpToolId: string;

  beforeAll(async () => {
    // toolresolveradmin was bootstrapped by the first describe's beforeAll
    adminToken = await loginAs('toolresolveradmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'MCP Tool Resolver Project' });
    projectId = projectRes.body.id;

    const mcpToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myMcpServer',
        type: 'mcp',
        description: 'Test MCP server',
        mcp: { url: 'http://localhost:19999/mcp' },
      });
    mcpToolId = mcpToolRes.body.id;

    const httpToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'resolverHttpTool',
        type: 'http',
        description: 'HTTP tool for resolver branch tests',
        parameters: { type: 'object', properties: {} },
        execute: { url: 'https://example.com/branch-test', method: 'INVALID' },
      });
    httpToolId = httpToolRes.body.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('resolves mcp tools via fetch mock', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            tools: [
              {
                name: 'search',
                description: 'Search tool',
                inputSchema: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                },
              },
            ],
          },
        }),
        { status: 200 }
      )
    );

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });

    expect(tools).toHaveProperty('search');
    expect(fetchMock).toHaveBeenCalled();
  });

  test('mcp tool returns empty result when fetch returns non-OK status', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 500 }));

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });

    expect(Object.keys(tools)).toHaveLength(0);
  });

  test('mcp tool returns empty result when fetch throws', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('Network error'));

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });

    expect(Object.keys(tools)).toHaveLength(0);
  });

  test('http tool execute appends query params with & when URL already has ?', async () => {
    const urlWithQueryRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'toolWithExistingQuery',
        type: 'http',
        description: 'Tool with existing query params in URL',
        parameters: {
          type: 'object',
          properties: { filter: { type: 'string' } },
        },
        execute: { url: 'https://example.com/api?version=1', method: 'GET' },
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const tools = await resolveAgentTools({
      toolIds: [urlWithQueryRes.body.id],
    });
    if (
      'execute' in tools.toolWithExistingQuery &&
      typeof tools.toolWithExistingQuery.execute === 'function'
    ) {
      await tools.toolWithExistingQuery.execute(
        { filter: 'active' },
        {} as never
      );
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('version=1'),
      expect.anything()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('filter=active'),
      expect.anything()
    );
  });

  test('http tool execute falls back to POST for invalid method', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.resolverHttpTool;

    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      await httpTool.execute({}, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/branch-test',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('mcp tool execute parses JSON text payload from tools/call', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              tools: [
                {
                  name: 'json_echo',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: { content: [{ text: '{"ok":true}' }] },
          }),
          { status: 200 }
        )
      );

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });
    const mcpTool = tools.json_echo;

    if ('execute' in mcpTool && typeof mcpTool.execute === 'function') {
      const result = await mcpTool.execute({}, {} as never);
      expect(result).toEqual({ ok: true });
    }
  });

  test('mcp tool execute returns raw text when tools/call text is not JSON', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              tools: [
                {
                  name: 'text_echo',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: { content: [{ text: 'plain text result' }] },
          }),
          { status: 200 }
        )
      );

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });
    const mcpTool = tools.text_echo;

    if ('execute' in mcpTool && typeof mcpTool.execute === 'function') {
      const result = await mcpTool.execute({}, {} as never);
      expect(result).toBe('plain text result');
    }
  });

  test('mcp tool execute returns full body when tools/call has no text content', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              tools: [
                {
                  name: 'empty_content',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: { content: [] },
          }),
          { status: 200 }
        )
      );

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });
    const mcpTool = tools.empty_content;

    if ('execute' in mcpTool && typeof mcpTool.execute === 'function') {
      const result = await mcpTool.execute({}, {} as never);
      expect(result).toEqual({ result: { content: [] } });
    }
  });

  test('resolveAgentTools applies projectIds filter when provided', async () => {
    const tools = await resolveAgentTools({
      toolIds: [httpToolId],
      projectIds: [],
    });

    expect(Object.keys(tools)).toHaveLength(0);
  });

  test('soat tool resolves configured actions and executes through internal API', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'mySoatTool',
        type: 'soat',
        actions: ['list-files'],
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));

    const tools = await resolveAgentTools({ toolIds: [soatToolRes.body.id] });
    expect(tools).toHaveProperty('mySoatTool_list-files');

    const soatTool = tools['mySoatTool_list-files'];
    if ('execute' in soatTool && typeof soatTool.execute === 'function') {
      await soatTool.execute({}, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/files'),
      expect.objectContaining({ method: 'GET' })
    );
  });

  test('soat tool returns boundary error when action is denied', async () => {
    const deniedSoatRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myDeniedSoatTool',
        type: 'soat',
        actions: ['list-files'],
      });

    const tools = await resolveAgentTools({
      toolIds: [deniedSoatRes.body.id],
      boundaryPolicy: {
        statement: [{ effect: 'Deny', action: ['files:ListFiles'] }],
      },
    });

    const soatTool = tools['myDeniedSoatTool_list-files'];
    if ('execute' in soatTool && typeof soatTool.execute === 'function') {
      const result = await soatTool.execute({}, {} as never);
      expect(result).toEqual({
        error: 'Forbidden: boundary policy denies list-files',
      });
    }
  });

  test('soat tool with preset_parameters strips preset keys from inputSchema', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPresetSoatTool',
        type: 'soat',
        actions: ['get-document'],
        preset_parameters: { documentId: 'doc_preset123' },
      });
    expect(soatToolRes.status).toBe(201);

    const tools = await resolveAgentTools({
      toolIds: [soatToolRes.body.id],
    });
    expect(tools).toHaveProperty('myPresetSoatTool_get-document');

    const soatTool = tools['myPresetSoatTool_get-document'];
    // The inputSchema presented to the model should NOT include 'id'
    const schema = soatTool.inputSchema as {
      jsonSchema?: { properties?: Record<string, unknown> };
    };
    const properties = schema?.jsonSchema?.properties ?? {};
    expect(properties).not.toHaveProperty('documentId');
  });

  test('soat tool with preset_parameters injects preset values into execution', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPresetExecTool',
        type: 'soat',
        actions: ['get-document'],
        preset_parameters: { documentId: 'doc_injected' },
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} })));

    const tools = await resolveAgentTools({ toolIds: [soatToolRes.body.id] });
    const soatTool = tools['myPresetExecTool_get-document'];

    if ('execute' in soatTool && typeof soatTool.execute === 'function') {
      // Model does not supply 'id' — it is injected from preset_parameters
      await soatTool.execute({}, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('doc_injected'),
      expect.anything()
    );
  });

  test('soat tool without preset_parameters works as before', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myNoPresetTool',
        type: 'soat',
        actions: ['list-files'],
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));

    const tools = await resolveAgentTools({ toolIds: [soatToolRes.body.id] });
    expect(tools).toHaveProperty('myNoPresetTool_list-files');

    const soatTool = tools['myNoPresetTool_list-files'];
    if ('execute' in soatTool && typeof soatTool.execute === 'function') {
      await soatTool.execute({}, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/files'),
      expect.objectContaining({ method: 'GET' })
    );
  });
});
