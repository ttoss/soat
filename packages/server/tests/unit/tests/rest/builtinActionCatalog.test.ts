import crypto from 'node:crypto';

import { db } from 'src/db';
import { emitApproval } from 'src/lib/approvals';
import {
  registerBuiltinActionCatalog,
  resetBuiltinActionCatalog,
} from 'src/lib/builtinActionCatalog';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { createScopedPrincipal } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A deployment's `builtin` catalog: with `allow: [list-agents]` and one added
 * action, `send-note`, served by a registered MCP server, a `builtin` tool may
 * name exactly those two, whatever path writes it.
 */
const NOTE_PATH = '/notes-mcp';
const ASSERTION_HEADER = 'x-soat-tool-assertion';
const SEND_NOTE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

let turn: AgentToolTurn;
let writer: { userToken: string; projectId: string };
let holder: { userToken: string; projectId: string };
const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

const createTool = (args: {
  token: string;
  projectId: string;
  actions: string[];
}) => {
  return authenticatedTestClient(args.token)
    .post('/api/v1/tools')
    .send({
      project_id: args.projectId,
      name: `catalog-${crypto.randomUUID().slice(0, 8)}`,
      type: 'builtin',
      actions: args.actions,
    });
};

const expectRefused = (res: {
  status: number;
  body: { error: { code: string; message: string } };
}) => {
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('VALIDATION_FAILED');
  // A formation reports it in `meta.details`.
  expect(JSON.stringify(res.body.error)).toMatch(/not offered.*get-agent/);
};

beforeAll(async () => {
  process.env.TOOL_ASSERTION_PRIVATE_KEY = crypto
    .generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  turn = await startAgentToolTurn({ prefix: 'builtincatalog' });
  writer = {
    projectId: turn.projectId,
    userToken: await createScopedPrincipal({
      adminToken: turn.adminToken,
      projectId: turn.projectId,
      username: 'catalogwriter',
      actions: ['tools:CreateTool', 'agents:ListAgents'],
    }),
  };
  holder = {
    projectId: turn.projectId,
    userToken: await createScopedPrincipal({
      adminToken: turn.adminToken,
      projectId: turn.projectId,
      username: 'catalogholder',
      actions: ['tools:CreateTool', 'agents:ListAgents', 'secrets:ListSecrets'],
    }),
  };
  registerBuiltinActionCatalog({
    allow: new Set(['list-agents']),
    added: {
      url: `${turn.target.baseUrl}${NOTE_PATH}`,
      tools: new Map([
        [
          'send-note',
          [{ action: 'secrets:ListSecrets', resourceType: 'secret' }],
        ],
      ]),
    },
  });
});

beforeEach(() => {
  turn.target.reset();
  turn.target.reply(NOTE_PATH, (body) => {
    const result =
      body.method === 'tools/list'
        ? {
            tools: [
              {
                name: 'send-note',
                description: 'Send a note',
                inputSchema: SEND_NOTE_SCHEMA,
              },
            ],
          }
        : { content: [{ type: 'text', text: '{"sent":true}' }] };
    return { body: { jsonrpc: '2.0', id: body.id, result } };
  });
});

afterAll(async () => {
  resetBuiltinActionCatalog();
  if (savedKey === undefined) delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
  else process.env.TOOL_ASSERTION_PRIVATE_KEY = savedKey;
  await turn.close();
});

describe('POST /api/v1/tools — builtin', () => {
  test('a writer holding both declared actions creates [list-agents, send-note]', async () => {
    const res = await createTool({
      token: holder.userToken,
      projectId: holder.projectId,
      actions: ['list-agents', 'send-note'],
    });
    expect(res.status).toBe(201);
    expect(res.body.actions).toEqual(['list-agents', 'send-note']);
  });

  test("a writer missing send-note's declared action is refused", async () => {
    const res = await createTool({
      token: writer.userToken,
      projectId: writer.projectId,
      actions: ['list-agents', 'send-note'],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACTION_NOT_HELD');
    expect(res.body.error.meta.action).toBe('secrets:ListSecrets');
  });

  test('a native action outside allow is refused', async () => {
    const res = await createTool({
      token: turn.adminToken,
      projectId: turn.projectId,
      actions: ['get-agent'],
    });
    expectRefused(res);
  });

  test('with no catalog every native action is offered', async () => {
    resetBuiltinActionCatalog();
    try {
      const res = await createTool({
        token: turn.adminToken,
        projectId: turn.projectId,
        actions: ['get-agent'],
      });
      expect(res.status).toBe(201);
    } finally {
      registerBuiltinActionCatalog({
        allow: new Set(['list-agents']),
        added: {
          url: `${turn.target.baseUrl}${NOTE_PATH}`,
          tools: new Map([
            [
              'send-note',
              [{ action: 'secrets:ListSecrets', resourceType: 'secret' }],
            ],
          ]),
        },
      });
    }
  });
});

describe('POST /api/v1/agents — inline builtin tool', () => {
  test('a native action outside allow is refused', async () => {
    const res = await authenticatedTestClient(turn.adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: turn.projectId,
        ai_provider_id: (
          await authenticatedTestClient(turn.adminToken).get(
            `/api/v1/ai-providers?project_id=${turn.projectId}`
          )
        ).body.data[0].id,
        name: turn.unique('agent'),
        tool_bindings: [
          { tool: { name: 'inline', type: 'builtin', actions: ['get-agent'] } },
        ],
      });
    expectRefused(res);
  });
});

describe('POST /api/v1/formations — builtin tool resource', () => {
  test('a native action outside allow is refused', async () => {
    const res = await authenticatedTestClient(turn.adminToken)
      .post('/api/v1/formations')
      .send({
        project_id: turn.projectId,
        name: turn.unique('formation'),
        template: {
          resources: {
            Tool: {
              type: 'tool',
              properties: {
                name: 'formation-tool',
                type: 'builtin',
                actions: ['get-agent'],
              },
            },
          },
        },
      });
    expectRefused(res);
  });
});

describe('POST /api/v1/tools/:tool_id/call — added action', () => {
  test('calls send-note on its server', async () => {
    const tool = await createTool({
      token: turn.adminToken,
      projectId: turn.projectId,
      actions: ['send-note'],
    });
    expect(tool.status).toBe(201);

    const res = await authenticatedTestClient(turn.adminToken)
      .post(`/api/v1/tools/${tool.body.id}/call`)
      .send({ action: 'send-note', input: { text: 'direct' } });

    expect(res.status).toBe(200);
    const call = turn.target.requestsAt(NOTE_PATH).find((request) => {
      return request.body.method === 'tools/call';
    });
    expect(call?.body.params).toEqual({
      name: 'send-note',
      arguments: { text: 'direct' },
    });
    expect(call?.headers[ASSERTION_HEADER]).toEqual(expect.any(String));
  });

  test('a failure its server answers is 502 MCP_TOOL_ERROR', async () => {
    const tool = await createTool({
      token: turn.adminToken,
      projectId: turn.projectId,
      actions: ['send-note'],
    });
    expect(tool.status).toBe(201);
    turn.target.reply(NOTE_PATH, (body) => {
      return {
        body: {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32000, message: 'note refused' },
        },
      };
    });

    const res = await authenticatedTestClient(turn.adminToken)
      .post(`/api/v1/tools/${tool.body.id}/call`)
      .send({ action: 'send-note', input: { text: 'direct' } });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('MCP_TOOL_ERROR');
    expect(res.body.error.meta.mcp_tool).toBe('send-note');
  });

  test('an error its server answers structured is relayed as REST answers it', async () => {
    const tool = await createTool({
      token: turn.adminToken,
      projectId: turn.projectId,
      actions: ['send-note'],
    });
    expect(tool.status).toBe(201);
    turn.target.reply(NOTE_PATH, (body) => {
      return {
        body: {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: '409 The note closes a cycle.' }],
            structuredContent: {
              status: 409,
              error: {
                code: 'NOTE_CYCLE',
                message: 'The note closes a cycle.',
                meta: { note_id: 'note_1' },
              },
            },
          },
        },
      };
    });

    const res = await authenticatedTestClient(turn.adminToken)
      .post(`/api/v1/tools/${tool.body.id}/call`)
      .send({ action: 'send-note', input: { text: 'direct' } });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'NOTE_CYCLE',
      message: 'The note closes a cycle.',
      meta: { note_id: 'note_1' },
    });
  });
});

describe('POST /api/v1/agents/:agent_id/generate — added action', () => {
  test('calls send-note on its server with a verifiable assertion', async () => {
    const tool = await createTool({
      token: turn.adminToken,
      projectId: turn.projectId,
      actions: ['list-agents', 'send-note'],
    });
    expect(tool.status).toBe(201);
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: tool.body.id }],
    });

    const generation = await turn.generate({
      agentId,
      calls: [{ name: `${tool.body.name}_send-note`, args: { text: 'hi' } }],
    });

    expect(generation.results).toEqual([
      expect.objectContaining({ sent: true }),
    ]);
    const requests = turn.target.requestsAt(NOTE_PATH);
    const call = requests.find((request) => {
      return request.body.method === 'tools/call';
    });
    expect(call?.body.params).toEqual({
      name: 'send-note',
      arguments: { text: 'hi' },
    });
    const jwks = await testClient.get('/.well-known/tool-assertion-jwks.json');
    const token = call?.headers[ASSERTION_HEADER];
    expect(typeof token).toBe('string');
    const [header, payload, signature] = String(token).split('.');
    const valid = crypto.verify(
      null,
      Buffer.from(`${header}.${payload}`),
      crypto.createPublicKey({ key: jwks.body.keys[0], format: 'jwk' }),
      Buffer.from(signature, 'base64url')
    );
    expect(valid).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims.tool_id).toBe(tool.body.id);
    expect(claims.generation_id).toBe(generation.id);
  });
});

describe('POST /api/v1/agents/:agent_id/generate — added action unreachable', () => {
  test('a server that cannot list its tools is named to the model as unavailable', async () => {
    const tool = await createTool({
      token: turn.adminToken,
      projectId: turn.projectId,
      actions: ['send-note'],
    });
    expect(tool.status).toBe(201);
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: tool.body.id }],
    });
    turn.target.reply(NOTE_PATH, { status: 500, body: { error: 'down' } });

    await turn.generate({ agentId, calls: [] });

    const system = (turn.model.requests.at(-1)?.messages ?? [])
      .filter((message) => {
        return message.role === 'system';
      })
      .map((message) => {
        return JSON.stringify(message.content);
      })
      .join('\n');
    expect(system).toContain(tool.body.name);
    expect(system).toContain('unavailable');
  });
});

describe('POST /api/v1/approvals/:approval_id/approve — added action', () => {
  let approverToken: string;
  let toolId: string;
  let projectInternalId: number;

  const seedProposal = async () => {
    return emitApproval({
      projectId: projectInternalId,
      proposedAction: {
        toolId,
        action: 'send-note',
        arguments: { text: 'proposed' },
      },
      reasoning: 'Sends a note',
      expiresInSeconds: 3600,
    });
  };

  beforeAll(async () => {
    approverToken = await createScopedPrincipal({
      adminToken: turn.adminToken,
      projectId: turn.projectId,
      username: 'catalogapprover',
      actions: ['approvals:ResolveApproval', 'tools:CallTool'],
    });
    const tool = await createTool({
      token: turn.adminToken,
      projectId: turn.projectId,
      actions: ['send-note'],
    });
    expect(tool.status).toBe(201);
    toolId = tool.body.id;
    const project = await db.Project.findOne({
      where: { publicId: turn.projectId },
    });
    projectInternalId = project!.id as number;
  });

  test("editing needs send-note's declared action", async () => {
    const seeded = await seedProposal();

    const res = await authenticatedTestClient(approverToken)
      .post(`/api/v1/approvals/${seeded.id}/approve`)
      .send({ arguments: { text: 'edited' } });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('an approver holding the declared action may edit', async () => {
    const seeded = await seedProposal();

    const res = await authenticatedTestClient(turn.adminToken)
      .post(`/api/v1/approvals/${seeded.id}/approve`)
      .send({ arguments: { text: 'edited' } });

    expect(res.status).toBe(200);
  });
});
