import {
  buildContextHeaders,
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
      .post('/api/v1/agents/tools')
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
      .post('/api/v1/agents/tools')
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
      .post('/api/v1/agents/tools')
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

  beforeAll(async () => {
    // toolresolveradmin was bootstrapped by the first describe's beforeAll
    adminToken = await loginAs('toolresolveradmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'MCP Tool Resolver Project' });
    projectId = projectRes.body.id;

    const mcpToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents/tools')
      .send({
        project_id: projectId,
        name: 'myMcpServer',
        type: 'mcp',
        description: 'Test MCP server',
        mcp: { url: 'http://localhost:19999/mcp' },
      });
    mcpToolId = mcpToolRes.body.id;
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
      .post('/api/v1/agents/tools')
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
});
