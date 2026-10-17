import crypto from 'node:crypto';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import {
  type RecordedRequest,
  startToolTarget,
} from '../../fixtures/scriptedModel';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Every request an `mcp` tool sends carries a short-lived JWT the runtime signs
 * with its Ed25519 key, so the receiving server can tell which tool of which
 * project called it without holding any secret of the runtime's. Verified here
 * the way a receiver would: against the published JWKS, over the bytes that
 * arrived.
 */

const JWKS_PATH = '/.well-known/tool-assertion-jwks.json';
const DEFAULT_HEADER = 'x-soat-tool-assertion';

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

const decodeSegment = (segment: string): Record<string, unknown> => {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
};

/** A receiver's check: signature against the JWKS key named by `kid`. */
const verifyAssertion = (args: { token: string; keys: Jwk[] }) => {
  const [header, payload, signature] = args.token.split('.');
  const protectedHeader = decodeSegment(header);
  const jwk = args.keys.find((key) => {
    return key.kid === protectedHeader.kid;
  });
  if (!jwk) throw new Error(`no published key for kid ${protectedHeader.kid}`);
  const valid = crypto.verify(
    null,
    Buffer.from(`${header}.${payload}`),
    crypto.createPublicKey({
      key: jwk as crypto.JsonWebKeyInput['key'],
      format: 'jwk',
    }),
    Buffer.from(signature, 'base64url')
  );
  return { valid, header: protectedHeader, claims: decodeSegment(payload) };
};

const sha256 = (raw: string): string => {
  return crypto.createHash('sha256').update(raw).digest('base64url');
};

const assertionOf = (request: RecordedRequest, name = DEFAULT_HEADER) => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

describe('Tool assertions', () => {
  let turn: AgentToolTurn;
  let privateKeyPem: string;
  let publicJwk: JsonWebKey;
  const savedEnv = {
    key: process.env.TOOL_ASSERTION_PRIVATE_KEY,
    header: process.env.TOOL_ASSERTION_HEADER,
  };

  const rpc = (body: Record<string, unknown>, result: object) => {
    return { body: { jsonrpc: '2.0', id: body.id, result } };
  };

  /** An mcp tool on a fresh target path that lists one tool, `echo`. */
  const mcpTool = async (tool: Record<string, unknown> = {}) => {
    const path = `/${turn.unique('mcp')}`;
    turn.target.reply(path, (body) => {
      if (body.method === 'tools/list') {
        return rpc(body, { tools: [{ name: 'echo' }] });
      }
      return rpc(body, { content: [{ type: 'text', text: '{"ok":true}' }] });
    });
    const created = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${path}` },
      ...tool,
    });
    return { ...created, path, url: `${turn.target.baseUrl}${path}` };
  };

  const callEcho = (toolId: string, token = turn.adminToken) => {
    return authenticatedTestClient(token)
      .post(`/api/v1/tools/${toolId}/call`)
      .send({ action: 'echo', input: {} });
  };

  const publishedKeys = async (): Promise<Jwk[]> => {
    const res = await testClient.get(JWKS_PATH);
    expect(res.status).toBe(200);
    return res.body.keys;
  };

  beforeAll(async () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKeyPem = pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    publicJwk = pair.publicKey.export({ format: 'jwk' });
    turn = await startAgentToolTurn({ prefix: 'toolassertion' });
  });

  beforeEach(() => {
    process.env.TOOL_ASSERTION_PRIVATE_KEY = privateKeyPem;
    delete process.env.TOOL_ASSERTION_HEADER;
    turn.target.reset();
  });

  afterAll(async () => {
    process.env.TOOL_ASSERTION_PRIVATE_KEY = savedEnv.key;
    process.env.TOOL_ASSERTION_HEADER = savedEnv.header;
    if (savedEnv.key === undefined)
      delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
    if (savedEnv.header === undefined) delete process.env.TOOL_ASSERTION_HEADER;
    await turn.close();
  });

  describe(`GET ${JWKS_PATH}`, () => {
    test('publishes the public half of the signing key, unauthenticated', async () => {
      const res = await testClient.get(JWKS_PATH);

      expect(res.status).toBe(200);
      expect(res.body.keys).toHaveLength(1);
      const [key] = res.body.keys;
      expect(key).toEqual({
        kty: 'OKP',
        crv: 'Ed25519',
        x: publicJwk.x,
        kid: expect.any(String),
        alg: 'EdDSA',
        use: 'sig',
      });
      expect(key.d).toBeUndefined();
    });

    test('names the key by its RFC 7638 thumbprint', async () => {
      const [key] = await publishedKeys();

      const canonical = JSON.stringify({
        crv: 'Ed25519',
        kty: 'OKP',
        x: publicJwk.x,
      });
      expect(key.kid).toBe(sha256(canonical));
    });

    test('publishes no key when the deployment configures none', async () => {
      delete process.env.TOOL_ASSERTION_PRIVATE_KEY;

      const res = await testClient.get(JWKS_PATH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ keys: [] });
    });
  });

  describe('POST /api/v1/tools/:tool_id/call — mcp', () => {
    test('signs every request the call sends, over the bytes that arrived', async () => {
      const tool = await mcpTool();

      const res = await callEcho(tool.id);

      expect(res.status).toBe(200);
      const requests = turn.target.requestsAt(tool.path);
      expect(
        requests.map((request) => {
          return request.body.method;
        })
      ).toEqual(['tools/list', 'tools/call']);
      const keys = await publishedKeys();
      for (const request of requests) {
        const token = assertionOf(request);
        expect(token).toBeDefined();
        const { valid, header, claims } = verifyAssertion({
          token: token!,
          keys,
        });
        expect(valid).toBe(true);
        expect(header).toEqual({
          alg: 'EdDSA',
          typ: 'JWT',
          kid: keys[0].kid,
        });
        expect(claims.body_sha256).toBe(sha256(request.raw));
      }
    });

    test('names the tool, its project, the issuer and the target', async () => {
      const tool = await mcpTool();

      await callEcho(tool.id);

      const [listing] = turn.target.requestsAt(tool.path);
      const { claims } = verifyAssertion({
        token: assertionOf(listing)!,
        keys: await publishedKeys(),
      });
      expect(claims).toEqual({
        iss: expect.any(String),
        aud: tool.url,
        iat: expect.any(Number),
        exp: expect.any(Number),
        jti: expect.any(String),
        tool_id: tool.id,
        project_id: turn.projectId,
        body_sha256: expect.any(String),
      });
      expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    });

    test('the audience leaves out the query string', async () => {
      const tool = await mcpTool();
      await authenticatedTestClient(turn.adminToken)
        .patch(`/api/v1/tools/${tool.id}`)
        .send({ mcp: { url: `${tool.url}?region=eu` } });

      await callEcho(tool.id);

      const [listing] = turn.target.requestsAt(tool.path);
      expect(listing.url).toBe(`${tool.path}?region=eu`);
      const { claims } = verifyAssertion({
        token: assertionOf(listing)!,
        keys: await publishedKeys(),
      });
      expect(claims.aud).toBe(tool.url);
    });

    test("a header the tool defines under the assertion's name, in any casing, does not replace it", async () => {
      const tool = await mcpTool({
        mcp: {
          url: `${turn.target.baseUrl}/forged`,
          headers: { 'x-SOAT-tool-assertion': 'forged.token.value' },
        },
      });
      turn.target.reply('/forged', (body) => {
        return body.method === 'tools/list'
          ? rpc(body, { tools: [{ name: 'echo' }] })
          : rpc(body, { content: [] });
      });

      await callEcho(tool.id);

      const [listing] = turn.target.requestsAt('/forged');
      const token = assertionOf(listing);
      expect(token).not.toBe('forged.token.value');
      expect(
        verifyAssertion({ token: token!, keys: await publishedKeys() }).valid
      ).toBe(true);
    });

    test('a redirect to another origin does not carry the assertion', async () => {
      const elsewhere = await startToolTarget();
      try {
        elsewhere.reply('/mcp', (body) => {
          return body.method === 'tools/list'
            ? rpc(body, { tools: [{ name: 'echo' }] })
            : rpc(body, { content: [] });
        });
        const tool = await mcpTool();
        turn.target.reply(tool.path, {
          status: 307,
          headers: { Location: `${elsewhere.baseUrl}/mcp` },
        });

        await callEcho(tool.id);

        expect(assertionOf(turn.target.requestsAt(tool.path)[0])).toBeDefined();
        const [redirected] = elsewhere.requestsAt('/mcp');
        expect(redirected).toBeDefined();
        expect(assertionOf(redirected)).toBeUndefined();
      } finally {
        await elsewhere.close();
      }
    });

    test('TOOL_ASSERTION_HEADER renames the header', async () => {
      process.env.TOOL_ASSERTION_HEADER = 'X-Acme-Tool-Assertion';
      const tool = await mcpTool();

      await callEcho(tool.id);

      const [listing] = turn.target.requestsAt(tool.path);
      expect(assertionOf(listing)).toBeUndefined();
      expect(assertionOf(listing, 'x-acme-tool-assertion')).toBeDefined();
    });

    test('an invalid TOOL_ASSERTION_HEADER fails the call before anything is sent', async () => {
      process.env.TOOL_ASSERTION_HEADER = 'Bad Header';
      const tool = await mcpTool();

      const res = await callEcho(tool.id);

      expect(res.status).toBe(500);
      expect(turn.target.requestsAt(tool.path)).toHaveLength(0);
    });

    test('sends no assertion when the deployment configures no key', async () => {
      delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
      const tool = await mcpTool();

      const res = await callEcho(tool.id);

      expect(res.status).toBe(200);
      for (const request of turn.target.requestsAt(tool.path)) {
        expect(assertionOf(request)).toBeUndefined();
      }
    });

    test('a key that is not Ed25519 fails the call before anything is sent', async () => {
      process.env.TOOL_ASSERTION_PRIVATE_KEY = crypto
        .generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const tool = await mcpTool();

      const res = await callEcho(tool.id);

      expect(res.status).toBe(500);
      expect(turn.target.requestsAt(tool.path)).toHaveLength(0);
    });

    test('a call through a share names the calling project, and the caller cannot forge it', async () => {
      const tool = await mcpTool();
      const admin = authenticatedTestClient(turn.adminToken);
      const grantee = await admin
        .post('/api/v1/projects')
        .send({ name: 'Assertion grantee' });
      expect(grantee.status).toBe(201);
      const key = await admin
        .post('/api/v1/api-keys')
        .send({ name: 'Assertion grantee key', project_id: grantee.body.id });
      expect(key.status).toBe(201);
      const share = await admin.post('/api/v1/shares').send({
        project_id: turn.projectId,
        resource: `srn:${turn.projectId}:tool:${tool.id}`,
        actions: ['tools:CallTool'],
        grantee: grantee.body.id,
      });
      expect(share.status).toBe(201);
      const accepted = await authenticatedTestClient(key.body.key).post(
        `/api/v1/shares/${share.body.id}/accept`
      );
      expect(accepted.status).toBe(200);

      const res = await authenticatedTestClient(key.body.key)
        .post(`/api/v1/tools/${tool.id}/call`)
        .send({
          action: 'echo',
          input: {},
          tool_context: { calling_project_id: 'proj_forged' },
        });

      expect(res.status).toBe(200);
      const [listing] = turn.target.requestsAt(tool.path);
      const { claims } = verifyAssertion({
        token: assertionOf(listing)!,
        keys: await publishedKeys(),
      });
      expect(claims.project_id).toBe(turn.projectId);
      expect(claims.calling_project_id).toBe(grantee.body.id);
    });

    test('a caller-supplied identity key never reaches the claims', async () => {
      const tool = await mcpTool();

      await authenticatedTestClient(turn.adminToken)
        .post(`/api/v1/tools/${tool.id}/call`)
        .send({
          action: 'echo',
          input: {},
          tool_context: { session_id: 'sess_forged', tenant: 'acme' },
        });

      const [listing] = turn.target.requestsAt(tool.path);
      const { claims } = verifyAssertion({
        token: assertionOf(listing)!,
        keys: await publishedKeys(),
      });
      expect(claims.session_id).toBeUndefined();
      expect(claims.tenant).toBeUndefined();
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate — mcp binding', () => {
    test('the listing and the call the model makes are both signed', async () => {
      const tool = await mcpTool();
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });

      await turn.generate({ agentId, calls: [{ name: 'echo', args: {} }] });

      const requests = turn.target.requestsAt(tool.path);
      expect(
        requests.map((request) => {
          return request.body.method;
        })
      ).toEqual(['tools/list', 'tools/call']);
      const keys = await publishedKeys();
      for (const request of requests) {
        const { valid, claims } = verifyAssertion({
          token: assertionOf(request)!,
          keys,
        });
        expect(valid).toBe(true);
        expect(claims.tool_id).toBe(tool.id);
        expect(claims.project_id).toBe(turn.projectId);
      }
    });

    test('a turn in a session names the session', async () => {
      const tool = await mcpTool();
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });
      const session = await authenticatedTestClient(turn.adminToken)
        .post('/api/v1/sessions')
        .send({ agent_id: agentId });
      expect(session.status).toBe(201);

      const message = await authenticatedTestClient(turn.adminToken)
        .post(`/api/v1/sessions/${session.body.id}/messages`)
        .send({
          message: JSON.stringify({ calls: [{ name: 'echo', args: {} }] }),
        });
      expect(message.status).toBe(201);

      const res = await authenticatedTestClient(turn.adminToken)
        .post(`/api/v1/sessions/${session.body.id}/generate?wait=true`)
        .send({});
      expect(res.status).toBe(200);

      const [listing] = turn.target.requestsAt(tool.path);
      const { claims } = verifyAssertion({
        token: assertionOf(listing)!,
        keys: await publishedKeys(),
      });
      expect(claims.session_id).toBe(session.body.id);
    });
  });
});
