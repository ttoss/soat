import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { createScopedPrincipal } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * `GET /tools/{tool_id}/actions` answers an `mcp` tool's surface as a model
 * bound to it sees it: the binding's lists applied, presets hidden, the
 * server reached with the tool's resolved credential.
 */

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    folder: { type: 'string' },
  },
  required: ['query', 'folder'],
};

describe('GET /api/v1/tools/{tool_id}/actions', () => {
  let turn: AgentToolTurn;
  let secretId: string;

  const listing = (body: Record<string, unknown>) => {
    if (body.method !== 'tools/list') {
      return { status: 400, body: { error: 'unexpected method' } };
    }
    return {
      body: {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [
            {
              name: 'search',
              description: 'Search documents',
              inputSchema: SEARCH_SCHEMA,
            },
            {
              name: 'delete',
              description: 'Delete a document',
              inputSchema: {
                type: 'object',
                properties: { id: { type: 'string' } },
              },
            },
            { name: 'ping' },
          ],
        },
      },
    };
  };

  const mcpTool = async (
    extra: Record<string, unknown> = {},
    headers?: Record<string, string>
  ) => {
    const path = `/${turn.unique('mcp')}`;
    turn.target.reply(path, listing);
    const created = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${path}`, headers },
      ...extra,
    });
    return { ...created, path };
  };

  const listActions = (toolId: string, token = turn.adminToken, query = '') => {
    return authenticatedTestClient(token).get(
      `/api/v1/tools/${toolId}/actions${query}`
    );
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'toolactions' });
    const secret = await turn
      .api()
      .post('/api/v1/secrets')
      .send({
        project_id: turn.projectId,
        name: turn.unique('api-key'),
        value: 'SUPER-SECRET-VALUE',
      });
    expect(secret.status).toBe(201);
    secretId = secret.body.id;
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  test('answers each listed action with its name, description and input schema', async () => {
    const tool = await mcpTool();

    const res = await listActions(tool.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          name: 'search',
          description: 'Search documents',
          input_schema: SEARCH_SCHEMA,
        },
        {
          name: 'delete',
          description: 'Delete a document',
          input_schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
        },
        {
          name: 'ping',
          description: null,
          input_schema: { type: 'object', properties: {} },
        },
      ],
      next_cursor: null,
    });
  });

  test('pages the listing by limit and cursor', async () => {
    const tool = await mcpTool();

    const first = await listActions(tool.id, turn.adminToken, '?limit=2');
    const second = await listActions(
      tool.id,
      turn.adminToken,
      `?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`
    );

    const names = (body: { data: Array<{ name: string }> }) => {
      return body.data.map((action) => {
        return action.name;
      });
    };
    expect(names(first.body)).toEqual(['search', 'delete']);
    expect(names(second.body)).toEqual(['ping']);
    expect(second.body.next_cursor).toBeNull();
  });

  test('applies actions and denied_actions', async () => {
    const tool = await mcpTool({
      actions: ['search', 'delete'],
      denied_actions: ['delete'],
    });

    const res = await listActions(tool.id);

    expect(res.status).toBe(200);
    expect(
      res.body.data.map((action: { name: string }) => {
        return action.name;
      })
    ).toEqual(['search']);
  });

  test('hides a preset key from the schema that declares it', async () => {
    const tool = await mcpTool({ preset_parameters: { folder: '/pinned' } });

    const res = await listActions(tool.id);

    expect(res.status).toBe(200);
    expect(res.body.data[0].input_schema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
  });

  test('reaches the server with the secret resolved, and answers without it', async () => {
    const tool = await mcpTool(
      {},
      { 'X-Api-Key': `key {{secret:${secretId}}}` }
    );

    const res = await listActions(tool.id);

    expect(res.status).toBe(200);
    expect(turn.target.requestsAt(tool.path)[0]?.headers['x-api-key']).toBe(
      'key SUPER-SECRET-VALUE'
    );
    expect(JSON.stringify(res.body)).not.toContain('SUPER-SECRET-VALUE');
  });

  test('a server that fails the listing is a 502 MCP_TOOL_ERROR', async () => {
    const tool = await mcpTool();
    turn.target.reply(tool.path, { status: 500, body: { error: 'down' } });

    const res = await listActions(tool.id);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('MCP_TOOL_ERROR');
  });

  test('a tool that is not mcp is a 400', async () => {
    const tool = await turn.createTool();

    const res = await listActions(tool.id);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('an unknown tool is a 404', async () => {
    const res = await listActions('tool_doesnotexist');

    expect(res.status).toBe(404);
  });

  test('an unauthenticated request is a 401', async () => {
    const tool = await mcpTool();

    const res = await testClient.get(`/api/v1/tools/${tool.id}/actions`);

    expect(res.status).toBe(401);
  });

  test('a caller who can read but not call the tool is a 403, and nothing is sent', async () => {
    const tool = await mcpTool();
    const readerToken = await createScopedPrincipal({
      adminToken: turn.adminToken,
      projectId: turn.projectId,
      username: turn.unique('toolactionsreader'),
      actions: ['tools:GetTool'],
    });

    const res = await listActions(tool.id, readerToken);

    expect(res.status).toBe(403);
    expect(turn.target.requestsAt(tool.path)).toHaveLength(0);
  });
});
