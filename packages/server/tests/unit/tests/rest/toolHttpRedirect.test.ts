import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { startToolTarget, type ToolTarget } from '../../fixtures/scriptedModel';

// A header whose value came from a secret is a credential for the tool's own
// origin: a redirect elsewhere must not carry it.

describe('POST /api/v1/tools/{tool_id}/call — http redirects', () => {
  let turn: AgentToolTurn;
  let elsewhere: ToolTarget;
  let secretId: string;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'httpredirect' });
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

  /** An http tool whose target redirects with a 307 to `location`. */
  const redirectingTool = async (args: { location: string }) => {
    const name = turn.unique('http');
    turn.target.reply(`/${name}`, {
      status: 307,
      headers: { Location: args.location },
    });
    const tool = await turn.createTool({
      name,
      parameters: { type: 'object', properties: {} },
      execute: {
        url: `${turn.target.baseUrl}/${name}`,
        method: 'POST',
        headers: {
          'X-Api-Key': `key {{secret:${secretId}}}`,
          'X-Plain': 'plain',
        },
      },
    });
    return tool;
  };

  const call = (toolId: string) => {
    return turn.api().post(`/api/v1/tools/${toolId}/call`).send({});
  };

  test('a secret-bearing header is not sent to another origin', async () => {
    const tool = await redirectingTool({
      location: `${elsewhere.baseUrl}/landing`,
    });

    expect((await call(tool.id)).status).toBe(200);

    const [request] = elsewhere.requestsAt('/landing');
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.headers['x-plain']).toBe('plain');
  });

  test('a secret-bearing header follows a same-origin redirect', async () => {
    const tool = await redirectingTool({
      location: `${turn.target.baseUrl}/landing`,
    });

    expect((await call(tool.id)).status).toBe(200);

    const [request] = turn.target.requestsAt('/landing');
    expect(request.headers['x-api-key']).toBe('key SUPER-SECRET-VALUE');
  });
});
