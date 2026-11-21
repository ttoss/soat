import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import {
  type AdmissionService,
  startAdmissionService,
} from '../../fixtures/admissionService';
import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * An IAM token's `tool_context` layer is stamped over every tool call the
 * token makes and every call its work starts; keys under the deployment's
 * reserved prefix belong to token layers alone.
 */

const PREFIX_ENV = 'SOAT_RESERVED_TOOL_CONTEXT_PREFIX';
const HEADER = 'x-soat-context-plat_tenant';

const BOUND = {
  statement: [
    {
      effect: 'Allow',
      action: ['agents:*', 'tools:*', 'sessions:*'],
    },
  ],
};

describe('IAM token tool_context layer', () => {
  let turn: AgentToolTurn;
  let service: AdmissionService;
  let pinningKey: string;
  let plainKey: string;
  let httpTool: { id: string; name: string };
  let relayTool: { id: string; name: string };
  let httpAgentId: string;
  let relayAgentId: string;
  let mcpTool: { id: string };
  let mcpPath: string;
  let previousPrefix: string | undefined;
  const previousAssertionKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

  const mint = (key: string, body: Record<string, unknown>) => {
    return authenticatedTestClient(key)
      .post('/api/v1/iam/tokens')
      .send({ policy: BOUND, ...body });
  };

  const layeredToken = async (): Promise<string> => {
    const res = await mint(pinningKey, {
      tool_context: { plat_tenant: 'acct_1' },
    });
    expect(res.status).toBe(201);
    return res.body.token as string;
  };

  const mintKey = async (actions: string[]): Promise<string> => {
    const policyId = await turn.createPolicy({
      statement: [{ effect: 'Allow', action: actions }],
    });
    const res = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({
        name: turn.unique('key'),
        project_id: turn.projectId,
        policy_ids: [policyId],
      });
    expect(res.status).toBe(201);
    return res.body.key as string;
  };

  /** The `plat_tenant` header each call to the http tool carried. */
  const tenantsSent = (): unknown[] => {
    return turn.target.requestsAt(`/${httpTool.name}`).map((request) => {
      return request.headers[HEADER];
    });
  };

  beforeAll(async () => {
    previousPrefix = process.env[PREFIX_ENV];
    process.env[PREFIX_ENV] = 'plat_';
    process.env.TOOL_ASSERTION_PRIVATE_KEY = crypto
      .generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    service = await startAdmissionService();
    turn = await startAgentToolTurn({ prefix: 'tcxlayer' });
    const actions = ['agents:*', 'tools:*', 'sessions:*', 'iam:CreateToken'];
    pinningKey = await mintKey([...actions, 'iam:PinReservedToolContext']);
    plainKey = await mintKey(actions);
    httpTool = await turn.createTool();
    relayTool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['call-tool'],
      preset_parameters: { tool_id: httpTool.id },
    });
    httpAgentId = await turn.createAgent({
      tool_bindings: [{ tool_id: httpTool.id }],
    });
    relayAgentId = await turn.createAgent({
      tool_bindings: [{ tool_id: relayTool.id }],
    });
    mcpPath = `/${turn.unique('mcp')}`;
    turn.target.reply(mcpPath, (body) => {
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'echo' }] }
          : { content: [{ type: 'text', text: '{"ok":true}' }] };
      return { body: { jsonrpc: '2.0', id: body.id, result } };
    });
    mcpTool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${mcpPath}` },
    });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    if (previousPrefix === undefined) delete process.env[PREFIX_ENV];
    else process.env[PREFIX_ENV] = previousPrefix;
    if (previousAssertionKey === undefined) {
      delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
    } else {
      process.env.TOOL_ASSERTION_PRIVATE_KEY = previousAssertionKey;
    }
    await turn.close();
    await service.close();
  });

  describe('POST /api/v1/iam/tokens', () => {
    test('signs the layer into the token', async () => {
      const token = await layeredToken();

      expect(jwt.decode(token, { json: true })?.tcx).toEqual({
        plat_tenant: 'acct_1',
      });
    });

    test('401 without a credential', async () => {
      const res = await testClient
        .post('/api/v1/iam/tokens')
        .send({ policy: BOUND, tool_context: { tenant: 'a' } });

      expect(res.status).toBe(401);
    });

    test('a key without iam:PinReservedToolContext pins an unreserved key', async () => {
      const res = await mint(plainKey, { tool_context: { tenant: 'a' } });

      expect(res.status).toBe(201);
    });

    test('400 for a reserved key without iam:PinReservedToolContext', async () => {
      const res = await mint(plainKey, {
        tool_context: { PLAT_tenant: 'acct_1' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TOOL_CONTEXT_KEY');
    });

    test('400 for a server identity key', async () => {
      const res = await mint(pinningKey, {
        tool_context: { session_id: 'sess_forged' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TOOL_CONTEXT_KEY');
    });

    test('400 for a layer that is not a bag of strings', async () => {
      const res = await mint(pinningKey, { tool_context: { tenant: 1 } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('a call on the token', () => {
    test('a direct call sends the layer over a forged key in any casing', async () => {
      const res = await authenticatedTestClient(await layeredToken())
        .post(`/api/v1/tools/${httpTool.id}/call`)
        .send({
          input: { amount: 1 },
          tool_context: { PLAT_TENANT: 'forged', note: 'kept' },
        });

      expect(res.status).toBe(200);
      const [request] = turn.target.requestsAt(`/${httpTool.name}`);
      expect(request.headers[HEADER]).toBe('acct_1');
      expect(request.headers['x-soat-context-note']).toBe('kept');
    });

    test('a generation tool call sends the layer beside the body bag', async () => {
      const res = await authenticatedTestClient(await layeredToken())
        .post(`/api/v1/agents/${httpAgentId}/generate?wait=true`)
        .send({
          messages: [
            proposeCalls([{ name: httpTool.name, args: { amount: 2 } }]),
          ],
          tool_context: { note: 'caller' },
        });

      expect(res.status).toBe(200);
      expect(tenantsSent()).toEqual(['acct_1']);
    });

    test('a nested builtin call-tool from the work sends the layer', async () => {
      const res = await authenticatedTestClient(await layeredToken())
        .post(`/api/v1/agents/${relayAgentId}/generate?wait=true`)
        .send({
          messages: [
            proposeCalls([
              {
                name: `${relayTool.name}_call-tool`,
                args: { input: { amount: 3 } },
              },
            ]),
          ],
          tool_context: { note: 'caller' },
        });

      expect(res.status).toBe(200);
      expect(tenantsSent()).toEqual(['acct_1']);
    });

    test('a caller without a layer has reserved keys stripped', async () => {
      const res = await turn
        .api()
        .post(`/api/v1/tools/${httpTool.id}/call`)
        .send({
          input: { amount: 4 },
          tool_context: { plat_tenant: 'forged' },
        });

      expect(res.status).toBe(200);
      expect(tenantsSent()).toEqual([undefined]);
    });

    test('admission sees the caller bag without the layer', async () => {
      service.declare({ actions: ['tools:CallTool'] });
      try {
        const res = await authenticatedTestClient(await layeredToken())
          .post(`/api/v1/tools/${httpTool.id}/call`)
          .send({
            input: { amount: 5 },
            tool_context: { plat_tenant: 'forged' },
          });

        expect(res.status).toBe(200);
        expect(service.asked[0].body).toMatchObject({
          action: 'tools:CallTool',
          body: { tool_context: { plat_tenant: 'forged' } },
        });
        expect(tenantsSent()).toEqual(['acct_1']);
      } finally {
        service.undeclare();
      }
    });
  });

  describe('an On-Behalf-Of callback', () => {
    /** The assertion an `mcp` call made on the layered token sends. */
    const layeredAssertion = async (): Promise<string> => {
      const res = await authenticatedTestClient(await layeredToken())
        .post(`/api/v1/tools/${mcpTool.id}/call`)
        .send({ action: 'echo', input: {} });
      expect(res.status).toBe(200);
      const calls = turn.target.requestsAt(mcpPath).filter((request) => {
        return request.body.method === 'tools/call';
      });
      return calls.at(-1)!.headers['x-soat-tool-assertion'] as string;
    };

    test("a callback's tool call sends the token's layer over a forged key", async () => {
      const assertion = await layeredAssertion();

      const res = await authenticatedTestClient(plainKey)
        .post(`/api/v1/tools/${httpTool.id}/call`)
        .set('X-Soat-On-Behalf-Of', assertion)
        .send({
          input: { amount: 6 },
          tool_context: { Plat_Tenant: 'forged' },
        });

      expect(res.status).toBe(200);
      expect(tenantsSent()).toEqual(['acct_1']);
    });

    test('work the callback starts sends the layer', async () => {
      const assertion = await layeredAssertion();

      const res = await authenticatedTestClient(plainKey)
        .post(`/api/v1/agents/${relayAgentId}/generate?wait=true`)
        .set('X-Soat-On-Behalf-Of', assertion)
        .send({
          messages: [
            proposeCalls([
              {
                name: `${relayTool.name}_call-tool`,
                args: { input: { amount: 7 } },
              },
            ]),
          ],
          tool_context: { note: 'caller' },
        });

      expect(res.status).toBe(200);
      expect(tenantsSent()).toEqual(['acct_1']);
    });

    test('a callback on an assertion without a layer carries none', async () => {
      const direct = await authenticatedTestClient(plainKey)
        .post(`/api/v1/tools/${mcpTool.id}/call`)
        .send({ action: 'echo', input: {} });
      expect(direct.status).toBe(200);
      const [call] = turn.target.requestsAt(mcpPath).filter((request) => {
        return request.body.method === 'tools/call';
      });

      const res = await authenticatedTestClient(plainKey)
        .post(`/api/v1/tools/${httpTool.id}/call`)
        .set(
          'X-Soat-On-Behalf-Of',
          call.headers['x-soat-tool-assertion'] as string
        )
        .send({
          input: { amount: 8 },
          tool_context: { plat_tenant: 'forged' },
        });

      expect(res.status).toBe(200);
      expect(tenantsSent()).toEqual([undefined]);
    });
  });

  describe('a write assigning a reserved key', () => {
    test('POST /api/v1/sessions is 400', async () => {
      const res = await turn
        .api()
        .post('/api/v1/sessions')
        .send({ agent_id: httpAgentId, tool_context: { Plat_tenant: 'x' } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TOOL_CONTEXT_KEY');
    });

    test('POST /api/v1/sessions from the token is 400 too', async () => {
      const res = await authenticatedTestClient(await layeredToken())
        .post('/api/v1/sessions')
        .send({ agent_id: httpAgentId, tool_context: { plat_tenant: 'x' } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TOOL_CONTEXT_KEY');
    });

    test('an unreserved key is stored', async () => {
      const res = await turn
        .api()
        .post('/api/v1/sessions')
        .send({ agent_id: httpAgentId, tool_context: { tenant: 'x' } });

      expect(res.status).toBe(201);
    });
  });
});
