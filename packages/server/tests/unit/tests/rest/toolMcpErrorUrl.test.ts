import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';

// An error names the URL as the tool was written, so a secret resolved into
// it for the request never reaches the caller.

describe('POST /api/v1/tools/{tool_id}/call — mcp error URL', () => {
  let turn: AgentToolTurn;
  let secretId: string;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'mcperrorurl' });
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

  const secretUrlTool = async () => {
    const name = turn.unique('mcp');
    const url = `${turn.target.baseUrl}/${name}?key={{secret:${secretId}}}`;
    const tool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url },
    });
    return { ...tool, path: `/${name}`, url };
  };

  const call = (toolId: string) => {
    return turn
      .api()
      .post(`/api/v1/tools/${toolId}/call`)
      .send({ action: 'echo', input: {} });
  };

  test('MCP_TOOL_ERROR names the secret reference, not its value', async () => {
    const tool = await secretUrlTool();
    turn.target.reply(tool.path, (body) => {
      return {
        body: {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32000, message: 'boom' },
        },
      };
    });

    const response = await call(tool.id);

    expect(response.body.error.code).toBe('MCP_TOOL_ERROR');
    expect(response.body.error.meta.mcp_url).toBe(tool.url);
    expect(JSON.stringify(response.body)).not.toContain('SUPER-SECRET-VALUE');
  });

  test('TOOL_UNREACHABLE names the secret reference, not its value', async () => {
    const tool = await secretUrlTool();
    turn.target.reply(tool.path, { destroy: true });

    const response = await call(tool.id);

    expect(response.body.error.code).toBe('TOOL_UNREACHABLE');
    expect(response.body.error.meta.tool_url).toBe(tool.url);
    expect(JSON.stringify(response.body)).not.toContain('SUPER-SECRET-VALUE');
  });
});
