import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient, loginAs } from '../../testClient';

// Every path a denial reaches the caller by carries one shape: `FORBIDDEN`,
// the action, the resource, whose policies denied it, and a message naming
// them.

describe('authorization denials', () => {
  let turn: AgentToolTurn;
  let userId: string;
  let userToken: string;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'authzdeny' });
    const user = await turn
      .api()
      .post('/api/v1/users')
      .send({ username: 'authzdenyother', password: 'authzdenypass' });
    expect(user.status).toBe(201);
    userId = user.body.id;
    const policy = await turn.createPolicy({
      statement: [
        {
          effect: 'Allow',
          action: ['tools:GetTool', 'formations:CreateFormation'],
          resource: [`srn:${turn.projectId}:*:*`],
        },
      ],
    });
    const attach = await turn
      .api()
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policy] });
    expect(attach.status).toBe(204);
    userToken = await loginAs('authzdenyother', 'authzdenypass');
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  test('a REST call names the action, the resource and the caller', async () => {
    const tool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['list-files'],
    });
    const resource = `srn:${turn.projectId}:tool:${tool.id}`;

    const res = await authenticatedTestClient(userToken).delete(
      `/api/v1/tools/${tool.id}`
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: `Forbidden: user ${userId}'s policies deny tools:DeleteTool on ${resource}`,
      meta: {
        action: 'tools:DeleteTool',
        resource,
        denied_by: { type: 'user', id: userId },
      },
    });
  });

  test('a tool on /mcp answers the denial as its error body', async () => {
    const tool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['list-files'],
    });
    const resource = `srn:${turn.projectId}:tool:${tool.id}`;

    const res = await authenticatedTestClient(userToken)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'call',
          arguments: { name: 'delete-tool', arguments: { tool_id: tool.id } },
        },
      });

    expect(res.body.result.isError).toBe(true);
    expect(JSON.parse(res.body.result.content[0].text)).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: `Forbidden: user ${userId}'s policies deny tools:DeleteTool on ${resource}`,
        meta: {
          action: 'tools:DeleteTool',
          resource,
          denied_by: { type: 'user', id: userId },
        },
      },
    });
  });

  test('a formation resource names the declared action', async () => {
    const resource = `srn:${turn.projectId}:guardrail:*`;

    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/formations')
      .send({
        project_id: turn.projectId,
        name: 'authz-deny-stack',
        template: {
          resources: {
            MyGuardrail: {
              type: 'guardrail',
              properties: { name: 'authz-deny-guardrail', class: 'A' },
            },
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: `Forbidden: user ${userId}'s policies deny guardrails:CreateGuardrail on ${resource}`,
      meta: {
        action: 'guardrails:CreateGuardrail',
        resource,
        denied_by: { type: 'user', id: userId },
        denied_actions: [
          {
            logical_id: 'MyGuardrail',
            resource_type: 'guardrail',
            action: 'guardrails:CreateGuardrail',
          },
        ],
      },
    });
  });

  test("an agent's builtin tool result carries the denial", async () => {
    const tool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['list-files'],
    });
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: tool.id }],
      policy_ids: [
        await turn.createPolicy({
          statement: [{ effect: 'Deny', action: ['files:GetFile'] }],
        }),
      ],
    });

    const { results } = await turn.generate({
      agentId,
      calls: [{ name: `${tool.name}_list-files`, args: {} }],
    });

    expect(results[0]).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: "Forbidden: the agent's policies deny files:GetFile",
        meta: {
          action: 'files:GetFile',
          resource: null,
          denied_by: { type: 'agent', id: null },
        },
      },
    });
  });

  test('an mcp tool relays the denial its server answers', async () => {
    const name = turn.unique('mcp');
    const tool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}/${name}` },
    });
    const denial = {
      code: 'FORBIDDEN',
      message:
        "Forbidden: agent agt_remote1234's policies deny memories:CreateMemory on srn:proj_remote:memory_store:*",
      meta: {
        action: 'memories:CreateMemory',
        resource: 'srn:proj_remote:memory_store:*',
        denied_by: { type: 'agent', id: 'agt_remote1234' },
      },
    };
    turn.target.reply(`/${name}`, (body) => {
      if (body.method === 'tools/list') {
        return {
          body: {
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'create_memory' }] },
          },
        };
      }
      return {
        body: {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            isError: true,
            content: [
              { type: 'text', text: JSON.stringify({ error: denial }) },
            ],
          },
        },
      };
    });

    const res = await turn
      .api()
      .post(`/api/v1/tools/${tool.id}/call`)
      .send({ action: 'create_memory', input: {} });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      ...denial,
      meta: { ...denial.meta, mcp_tool: 'create_memory' },
    });
  });
});
