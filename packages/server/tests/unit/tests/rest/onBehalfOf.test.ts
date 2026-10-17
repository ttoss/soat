import crypto from 'node:crypto';

import { flushAuditQueue } from 'src/lib/auditQueue';
import { ISSUER } from 'src/lib/serverIssuer';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A tool server writing back with its project's key forwards the assertion of
 * the call it serves in `X-Soat-On-Behalf-Of`; the write then records the
 * tool, the agent and the generation beside the key that wrote it.
 */

const HEADER = 'X-Soat-On-Behalf-Of';

const encode = (value: object): string => {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
};

const sign = (args: {
  privateKey: crypto.KeyObject;
  kid: string;
  claims: Record<string, unknown>;
}): string => {
  const input = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: args.kid })}.${encode(args.claims)}`;
  const signature = crypto.sign(null, Buffer.from(input), args.privateKey);
  return `${input}.${signature.toString('base64url')}`;
};

describe('On-Behalf-Of', () => {
  let turn: AgentToolTurn;
  let privateKey: crypto.KeyObject;
  let kid: string;
  let projectKey: string;
  let projectKeyId: string;
  let otherProjectKey: string;
  let playbookId: string;
  let token: string;
  let toolId: string;
  let agentId: string;
  let generationId: string;
  let seq = 0;
  const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

  const asAdmin = () => {
    return authenticatedTestClient(turn.adminToken);
  };

  const newCase = async () => {
    seq += 1;
    const res = await asAdmin()
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: `obo-${seq}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const writeAmount = (args: {
    caseId: string;
    credential: string;
    onBehalfOf?: string;
  }) => {
    const request = authenticatedTestClient(args.credential).post(
      `/api/v1/playbook-cases/${args.caseId}/inputs`
    );
    if (args.onBehalfOf) request.set(HEADER, args.onBehalfOf);
    return request.send({
      inputs: [
        { node: 'revenue', name: 'amount', value: 1, expected_revision: null },
      ],
    });
  };

  const claims = (overrides: Record<string, unknown> = {}) => {
    const iat = Math.floor(Date.now() / 1000);
    return {
      iss: ISSUER,
      aud: 'https://tools.example.com/mcp',
      iat,
      exp: iat + 60,
      jti: crypto.randomUUID(),
      tool_id: 'tool_V1StGXR8Z5jdHi6B',
      project_id: turn.projectId,
      ...overrides,
    };
  };

  beforeAll(async () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    process.env.TOOL_ASSERTION_PRIVATE_KEY = pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    turn = await startAgentToolTurn({ prefix: 'onbehalfof' });
    const jwks = await testClient.get('/.well-known/tool-assertion-jwks.json');
    kid = jwks.body.keys[0].kid;

    const path = `/${turn.unique('mcp')}`;
    turn.target.reply(path, (body) => {
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'echo' }] }
          : { content: [{ type: 'text', text: '{"ok":true}' }] };
      return { body: { jsonrpc: '2.0', id: body.id, result } };
    });
    const tool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${path}` },
    });
    toolId = tool.id;
    agentId = await turn.createAgent({ tool_bindings: [{ tool_id: toolId }] });
    generationId = (
      await turn.generate({ agentId, calls: [{ name: 'echo', args: {} }] })
    ).id;
    const call = turn.target.requestsAt(path).find((request) => {
      return request.body.method === 'tools/call';
    });
    token = call!.headers['x-soat-tool-assertion'] as string;

    const key = await asAdmin()
      .post('/api/v1/api-keys')
      .send({ name: 'obo key', project_id: turn.projectId });
    expect(key.status).toBe(201);
    projectKey = key.body.key;
    projectKeyId = key.body.id;
    const other = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'On-behalf-of other' });
    const otherKey = await asAdmin()
      .post('/api/v1/api-keys')
      .send({ name: 'obo other key', project_id: other.body.id });
    otherProjectKey = otherKey.body.key;

    const playbook = await asAdmin()
      .post('/api/v1/playbooks')
      .send({
        project_id: turn.projectId,
        name: 'obo',
        definition: {
          nodes: [
            {
              key: 'revenue',
              title: 'Revenue',
              kind: 'collect',
              inputs: [
                {
                  name: 'amount',
                  schema: { type: 'number' },
                  required: true,
                  source: 'manual',
                },
              ],
            },
          ],
        },
      });
    expect(playbook.status).toBe(201);
    playbookId = playbook.body.id;
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
    else process.env.TOOL_ASSERTION_PRIVATE_KEY = savedKey;
    await turn.close();
  });

  const entriesOf = async (caseId: string) => {
    const res = await asAdmin().get(`/api/v1/playbook-cases/${caseId}/entries`);
    expect(res.status).toBe(200);
    return res.body.data as Array<Record<string, unknown>>;
  };

  describe('a write with the assertion of the tool call it serves', () => {
    test('records the tool, the agent and the generation beside the key', async () => {
      const caseId = await newCase();

      const res = await writeAmount({
        caseId,
        credential: projectKey,
        onBehalfOf: token,
      });

      expect(res.status).toBe(200);
      const [entry] = await entriesOf(caseId);
      expect(entry).toMatchObject({
        created_by_principal_type: 'api_key',
        created_by_principal_id: projectKeyId,
      });
      expect(entry.on_behalf_of).toEqual({
        tool_id: toolId,
        agent_id: agentId,
        generation_id: generationId,
        session_id: null,
        actor_id: null,
      });
    });

    test('records it on the audit entry of the request', async () => {
      const caseId = await newCase();
      const res = await writeAmount({
        caseId,
        credential: projectKey,
        onBehalfOf: token,
      });
      expect(res.status).toBe(200);
      await flushAuditQueue();

      const audit = await asAdmin().get(
        `/api/v1/audit-log?project_id=${turn.projectId}&resource_public_id=${caseId}`
      );

      expect(audit.status).toBe(200);
      const [entry] = audit.body.data;
      expect(entry).toMatchObject({
        action: 'playbooks:WritePlaybookCaseInputs',
        on_behalf_of: { tool_id: toolId, generation_id: generationId },
      });
    });

    test('a write without the header records none', async () => {
      const caseId = await newCase();

      const res = await writeAmount({ caseId, credential: projectKey });

      expect(res.status).toBe(200);
      const [entry] = await entriesOf(caseId);
      expect(entry.on_behalf_of).toBeNull();
    });
  });

  describe('refusals', () => {
    test.each([
      [
        'a tampered assertion',
        () => {
          return `${token.slice(0, -4)}AAAA`;
        },
      ],
      [
        'a token that is not a JWT',
        () => {
          return 'not-a-token';
        },
      ],
      [
        'an expired assertion',
        () => {
          return sign({
            privateKey,
            kid,
            claims: claims({ exp: Math.floor(Date.now() / 1000) - 1 }),
          });
        },
      ],
      [
        'an assertion another key signed',
        () => {
          return sign({
            privateKey: crypto.generateKeyPairSync('ed25519').privateKey,
            kid,
            claims: claims(),
          });
        },
      ],
      [
        'an assertion another issuer signed',
        () => {
          return sign({
            privateKey,
            kid,
            claims: claims({ iss: 'https://elsewhere.example.com' }),
          });
        },
      ],
    ])('%s is 400 unverified', async (_, tokenOf) => {
      const caseId = await newCase();

      const res = await writeAmount({
        caseId,
        credential: projectKey,
        onBehalfOf: tokenOf(),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ON_BEHALF_OF_INVALID');
      expect(res.body.error.meta).toEqual({ reason: 'unverified' });
      expect(await entriesOf(caseId)).toEqual([]);
    });

    test('a key scoped to another project is 400', async () => {
      const caseId = await newCase();

      const res = await writeAmount({
        caseId,
        credential: otherProjectKey,
        onBehalfOf: token,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.meta).toEqual({ reason: 'project' });
    });

    test('a credential confined to no project is 400', async () => {
      const caseId = await newCase();

      const res = await writeAmount({
        caseId,
        credential: turn.adminToken,
        onBehalfOf: token,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.meta).toEqual({ reason: 'project' });
    });

    test('a deployment that signs nothing verifies nothing', async () => {
      const configured = process.env.TOOL_ASSERTION_PRIVATE_KEY;
      delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
      try {
        const caseId = await newCase();

        const res = await writeAmount({
          caseId,
          credential: projectKey,
          onBehalfOf: token,
        });

        expect(res.status).toBe(400);
        expect(res.body.error.meta).toEqual({ reason: 'unverified' });
      } finally {
        process.env.TOOL_ASSERTION_PRIVATE_KEY = configured;
      }
    });

    test('returns 401 without a credential', async () => {
      const res = await testClient
        .post('/api/v1/playbook-cases/pbk_case_absent/inputs')
        .set(HEADER, token)
        .send({ inputs: [] });

      expect(res.status).toBe(401);
    });
  });
});
