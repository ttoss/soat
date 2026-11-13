import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';
import { db } from 'src/db';
import { flushAuditQueue } from 'src/lib/auditQueue';
import { ISSUER } from 'src/lib/serverIssuer';
import { signToken } from 'src/lib/signedTokens';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient } from '../../testClient';

/**
 * Every tool assertion carries, encrypted, the authority of the work it was
 * sent for: a callback presenting it in `On-Behalf-Of` is capped by the key ∩
 * that authority, for a direct call as for a generation's.
 */

const HEADER = 'X-Soat-On-Behalf-Of';
const PRINCIPAL = { type: 'mcp_caller', id: 'caller_opaque_7d1f' };

const encode = (value: object): string => {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
};

const payloadOf = (assertion: string): string => {
  return Buffer.from(assertion.split('.')[1], 'base64url').toString('utf-8');
};

describe('On-Behalf-Of authority', () => {
  let turn: AgentToolTurn;
  let privateKey: crypto.KeyObject;
  let kid: string;
  let projectKey: string;
  let projectKeyId: string;
  let toolId: string;
  let mcpPath: string;
  let callbackAgent: string;
  let documentId: string;
  const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

  const mintKey = async (actions: string[]) => {
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

  const mintToken = async (actions: string[]) => {
    const res = await authenticatedTestClient(projectKey)
      .post('/api/v1/iam/tokens')
      .send({
        policy: { statement: [{ effect: 'Allow', action: actions }] },
        principal: PRINCIPAL,
      });
    expect(res.status).toBe(201);
    return res.body.token as string;
  };

  const lastAssertion = (): string => {
    const calls = turn.target.requestsAt(mcpPath).filter((request) => {
      return request.body.method === 'tools/call';
    });
    return calls[calls.length - 1].headers['x-soat-tool-assertion'] as string;
  };

  /** The assertion a direct `tools/call` made with `credential` sends. */
  const directCallAssertion = async (credential: string): Promise<string> => {
    const res = await authenticatedTestClient(credential)
      .post(`/api/v1/tools/${toolId}/call`)
      .send({ action: 'echo', input: {} });
    expect(res.status).toBe(200);
    return lastAssertion();
  };

  const generateWithDocument = (assertion?: string) => {
    const request = authenticatedTestClient(projectKey).post(
      `/api/v1/agents/${callbackAgent}/generate?wait=true`
    );
    if (assertion) request.set(HEADER, assertion);
    return request.send({
      messages: [
        {
          role: 'user',
          content: { type: 'document', document_id: documentId },
        },
      ],
    });
  };

  const readDocument = (assertion?: string) => {
    const request = authenticatedTestClient(projectKey).get(
      `/api/v1/documents/${documentId}`
    );
    if (assertion) request.set(HEADER, assertion);
    return request;
  };

  const generationCount = () => {
    return db.Generation.count({ where: { agentPublicId: callbackAgent } });
  };

  beforeAll(async () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    process.env.TOOL_ASSERTION_PRIVATE_KEY = pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    turn = await startAgentToolTurn({ prefix: 'oboauthority' });
    const jwks = await turn.api().get('/.well-known/tool-assertion-jwks.json');
    kid = jwks.body.keys[0].kid;

    mcpPath = `/${turn.unique('mcp')}`;
    turn.target.reply(mcpPath, (body) => {
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
      mcp: { url: `${turn.target.baseUrl}${mcpPath}` },
    });
    toolId = tool.id;

    const key = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({ name: 'tool server key', project_id: turn.projectId });
    expect(key.status).toBe(201);
    projectKey = key.body.key;
    projectKeyId = key.body.id;

    callbackAgent = await turn.createAgent({});
    const doc = await turn
      .api()
      .post('/api/v1/documents')
      .send({ project_id: turn.projectId, content: 'private guide' });
    expect(doc.status).toBe(201);
    documentId = doc.body.id;
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
    else process.env.TOOL_ASSERTION_PRIVATE_KEY = savedKey;
    await turn.close();
  });

  describe('a direct call made on an IAM token', () => {
    test('a callback generating from a document the token cannot read is 403 and starts nothing', async () => {
      const assertion = await directCallAssertion(
        await mintToken(['tools:CallTool', 'agents:*'])
      );
      const before = await generationCount();

      const res = await generateWithDocument(assertion);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(await generationCount()).toBe(before);
    });

    test('a denial by the cap names the assertion, not the key', async () => {
      const assertion = await directCallAssertion(
        await mintToken(['tools:CallTool'])
      );
      const resource = `srn:${turn.projectId}:document:${documentId}`;

      const res = await readDocument(assertion);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({
        message: `Forbidden: the On-Behalf-Of assertion's policies deny documents:GetDocument on ${resource}`,
        meta: { denied_by: { type: 'on_behalf_of', id: null } },
      });
    });

    test('a callback naming a builtin action the token cannot run is 403', async () => {
      const builtin = await turn.createTool({
        type: 'builtin',
        execute: undefined,
        parameters: undefined,
        actions: ['get-document'],
      });
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: builtin.id }],
      });
      const send = (assertion: string) => {
        return authenticatedTestClient(projectKey)
          .post(`/api/v1/agents/${agentId}/generate?wait=true`)
          .set(HEADER, assertion)
          .send({
            messages: [
              {
                role: 'user',
                content: {
                  type: 'tool_output',
                  tool_id: builtin.id,
                  action: 'get-document',
                  input: { document_id: documentId },
                },
              },
            ],
          });
      };

      const capped = await send(
        await directCallAssertion(
          await mintToken(['tools:CallTool', 'agents:*'])
        )
      );
      const full = await send(await directCallAssertion(projectKey));

      expect(capped.status).toBe(403);
      expect(capped.body.error.code).toBe('FORBIDDEN');
      expect(full.status).toBe(200);
    });

    test('the same callback for a call made on the full key works', async () => {
      const assertion = await directCallAssertion(projectKey);

      const res = await generateWithDocument(assertion);

      expect(res.status).toBe(200);
    });

    test('a tool server decoding the assertion reads neither the principal nor the policy', async () => {
      const assertion = await directCallAssertion(
        await mintToken(['tools:CallTool', 'agents:*'])
      );

      const payload = payloadOf(assertion);

      expect(payload).not.toContain(PRINCIPAL.id);
      expect(payload).not.toContain(PRINCIPAL.type);
      expect(payload).not.toContain('tools:CallTool');
      expect(payload).not.toContain('Allow');
    });

    test('the audit log records the principal of the callback', async () => {
      const assertion = await directCallAssertion(
        await mintToken(['tools:CallTool', 'documents:GetDocument'])
      );
      const res = await readDocument(assertion);
      expect(res.status).toBe(200);

      await flushAuditQueue();
      const entries = await turn
        .api()
        .get('/api/v1/audit-log')
        .query({ project_id: turn.projectId, principal_id: projectKeyId });
      expect(entries.status).toBe(200);
      const entry = (
        entries.body.data as Array<{
          action: string;
          detail: Record<string, unknown> | null;
        }>
      ).find((candidate) => {
        return (
          candidate.action === 'documents:GetDocument' &&
          candidate.detail?.on_behalf_of_principal !== undefined
        );
      });
      expect(entry?.detail?.on_behalf_of_principal).toEqual(PRINCIPAL);
    });
  });

  describe('every callback is capped', () => {
    test('a call a capped callback makes carries its cap on', async () => {
      const capped = await directCallAssertion(
        await mintToken(['tools:CallTool'])
      );
      const nested = await authenticatedTestClient(projectKey)
        .post(`/api/v1/tools/${toolId}/call`)
        .set(HEADER, capped)
        .send({ action: 'echo', input: {} });
      expect(nested.status).toBe(200);

      const res = await readDocument(lastAssertion());

      expect(res.status).toBe(403);
    });

    test('a direct call made on a narrow key caps its callback', async () => {
      const assertion = await directCallAssertion(
        await mintKey(['tools:CallTool'])
      );

      const capped = await readDocument(assertion);
      const alone = await readDocument();

      expect(capped.status).toBe(403);
      expect(alone.status).toBe(200);
    });

    test('a generation with no caller and an uncapped agent caps its callback', async () => {
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: toolId }],
      });
      const admin = jwt.decode(turn.adminToken) as { publicId: string };
      // An OAuth token starts a generation that records no caller.
      const oauthToken = signToken({
        typ: 'oauth',
        claims: {
          publicId: admin.publicId,
          role: 'admin',
          scope: `agents:* tools:* prj:${turn.projectId}`,
          prj: turn.projectId,
        },
        expiresIn: '1h',
      });
      const generation = await authenticatedTestClient(oauthToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [proposeCalls([{ name: 'echo', args: {} }])] });
      expect(generation.status).toBe(200);
      const assertion = lastAssertion();
      expect(payloadOf(assertion)).toContain(generation.body.id);

      const res = await readDocument(assertion);

      expect(res.status).toBe(403);
    });
  });

  describe('refusals', () => {
    const forged = (claims: Record<string, unknown>): string => {
      const iat = Math.floor(Date.now() / 1000);
      const input = `${encode({ alg: 'EdDSA', typ: 'JWT', kid })}.${encode({
        iss: ISSUER,
        aud: `${turn.target.baseUrl}${mcpPath}`,
        iat,
        exp: iat + 60,
        jti: crypto.randomUUID(),
        tool_id: toolId,
        project_id: turn.projectId,
        ...claims,
      })}`;
      const signature = crypto.sign(null, Buffer.from(input), privateKey);
      return `${input}.${signature.toString('base64url')}`;
    };

    test.each([
      ['carries no authority', {}],
      ['carries an authority this deployment cannot open', { ath: 'AAAA' }],
    ])('an assertion that %s is 400 bound', async (_, claims) => {
      const res = await readDocument(forged(claims));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ON_BEHALF_OF_INVALID');
      expect(res.body.error.meta).toEqual({ reason: 'bound' });
    });
  });
});
