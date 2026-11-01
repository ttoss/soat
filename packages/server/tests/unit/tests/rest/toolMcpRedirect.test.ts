import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { startToolTarget, type ToolTarget } from '../../fixtures/scriptedModel';

// A header whose value came from a secret is a credential for the server's own
// origin: a redirect elsewhere must not carry it.

describe('POST /api/v1/tools/{tool_id}/call — mcp redirects', () => {
  let turn: AgentToolTurn;
  let elsewhere: ToolTarget;
  let secretId: string;

  const mcpServer = (body: Record<string, unknown>) => {
    const result =
      body.method === 'tools/list'
        ? { tools: [{ name: 'echo' }] }
        : { content: [{ type: 'text', text: '{"ok":true}' }] };
    return { body: { jsonrpc: '2.0', id: body.id, result } };
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'mcpredirect' });
    elsewhere = await startToolTarget();
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
    elsewhere.reset();
  });

  afterAll(async () => {
    await elsewhere.close();
    await turn.close();
  });

  /** An mcp tool whose server redirects with a 307 to `location`. */
  const redirectingTool = async (args: { location: string }) => {
    const name = turn.unique('mcp');
    turn.target.reply(`/${name}`, {
      status: 307,
      headers: { Location: args.location },
    });
    return turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: {
        url: `${turn.target.baseUrl}/${name}`,
        headers: {
          'X-Api-Key': `key {{secret:${secretId}}}`,
          'X-Plain': 'plain',
        },
      },
    });
  };

  const call = (toolId: string) => {
    return turn
      .api()
      .post(`/api/v1/tools/${toolId}/call`)
      .send({ action: 'echo', input: {} });
  };

  test('a secret-bearing header is not sent to another origin', async () => {
    elsewhere.reply('/landing', mcpServer);
    const tool = await redirectingTool({
      location: `${elsewhere.baseUrl}/landing`,
    });

    expect((await call(tool.id)).status).toBe(200);

    const [request] = elsewhere.requestsAt('/landing');
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.headers['x-plain']).toBe('plain');
  });

  test('a secret-bearing header follows a same-origin redirect', async () => {
    turn.target.reply('/landing', mcpServer);
    const tool = await redirectingTool({
      location: `${turn.target.baseUrl}/landing`,
    });

    expect((await call(tool.id)).status).toBe(200);

    const [request] = turn.target.requestsAt('/landing');
    expect(request.headers['x-api-key']).toBe('key SUPER-SECRET-VALUE');
  });
});
