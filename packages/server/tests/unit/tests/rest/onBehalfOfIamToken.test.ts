import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';
import { db } from 'src/db';
import { signToken } from 'src/lib/signedTokens';
import { parseWorkAuthority } from 'src/lib/workAuthority';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient, workRequest } from '../../testClient';

/**
 * An IAM token carries `On-Behalf-Of` when the key that issued it is scoped to
 * the assertion's project: the request, and work it starts, is held to the
 * key ∩ the token's bound ∩ the assertion's authority.
 */

const HEADER = 'X-Soat-On-Behalf-Of';

describe('On-Behalf-Of on an IAM token', () => {
  let turn: AgentToolTurn;
  let projectKey: string;
  let projectKeyId: string;
  let otherProjectKey: string;
  let toolId: string;
  let mcpPath: string;
  let agentId: string;
  let documentId: string;
  const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

  const mintToken = async (args: { key: string; actions: string[] }) => {
    const res = await authenticatedTestClient(args.key)
      .post('/api/v1/iam/tokens')
      .send({
        policy: { statement: [{ effect: 'Allow', action: args.actions }] },
      });
    expect(res.status).toBe(201);
    return res.body.token as string;
  };

  const tokenFor = (actions: string[]) => {
    return mintToken({ key: projectKey, actions });
  };

  /** The assertion a direct `tools/call` made with `credential` sends. */
  const assertionOf = async (credential: string): Promise<string> => {
    const res = await authenticatedTestClient(credential)
      .post(`/api/v1/tools/${toolId}/call`)
      .send({ action: 'echo', input: {} });
    expect(res.status).toBe(200);
    const calls = turn.target.requestsAt(mcpPath).filter((request) => {
      return request.body.method === 'tools/call';
    });
    return calls.at(-1)!.headers['x-soat-tool-assertion'] as string;
  };

  const readDocument = (credential: string, assertion?: string) => {
    const request = authenticatedTestClient(credential).get(
      `/api/v1/documents/${documentId}`
    );
    if (assertion) request.set(HEADER, assertion);
    return request;
  };

  beforeAll(async () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    process.env.TOOL_ASSERTION_PRIVATE_KEY = pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    turn = await startAgentToolTurn({ prefix: 'oboiam' });

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
    agentId = await turn.createAgent({});

    const key = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({ name: 'tool server key', project_id: turn.projectId });
    expect(key.status).toBe(201);
    projectKey = key.body.key;
    projectKeyId = key.body.id;

    const other = await turn
      .api()
      .post('/api/v1/projects')
      .send({ name: turn.unique('other') });
    expect(other.status).toBe(201);
    const otherKey = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({ name: 'other key', project_id: other.body.id });
    expect(otherKey.status).toBe(201);
    otherProjectKey = otherKey.body.key;

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

  describe('a token its project key issued', () => {
    test('acts where its bound and the assertion both allow', async () => {
      const assertion = await assertionOf(projectKey);
      const token = await tokenFor(['documents:GetDocument']);

      const res = await readDocument(token, assertion);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(documentId);
    });

    test("an action outside the token's bound is 403 naming the token", async () => {
      const assertion = await assertionOf(projectKey);
      const token = await tokenFor(['documents:ListDocuments']);
      const { jti } = jwt.decode(token) as { jti: string };

      const res = await readDocument(token, assertion);

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_by).toEqual({
        type: 'iam_token',
        id: jti,
      });
    });

    test("an action outside the assertion's authority is 403 naming the assertion", async () => {
      const assertion = await assertionOf(await tokenFor(['tools:CallTool']));
      const token = await tokenFor(['documents:GetDocument']);

      const res = await readDocument(token, assertion);

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_by).toEqual({
        type: 'on_behalf_of',
        id: null,
      });
    });
  });

  describe('work the token starts', () => {
    /** Reads the document as the work a generation `token` starts. */
    const remintedFor = async (args: { token: string; assertion: string }) => {
      const res = await authenticatedTestClient(args.token)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .set(HEADER, args.assertion)
        .send({ messages: [{ role: 'user', content: 'hello' }] });
      expect(res.status).toBe(200);
      const gen = await db.Generation.findOne({
        where: { publicId: res.body.id },
      });
      expect(gen!.actedAsPrincipalId).toBe(projectKeyId);
      return workRequest({
        authority: parseWorkAuthority(gen!.authority)!,
        method: 'get',
        path: `/api/v1/documents/${documentId}`,
      });
    };

    test('is held to the bound and the assertion together', async () => {
      const full = await assertionOf(projectKey);
      const narrow = await assertionOf(
        await tokenFor(['tools:CallTool', 'agents:*'])
      );
      const reading = ['agents:*', 'documents:GetDocument'];

      const both = await remintedFor({
        token: await tokenFor(reading),
        assertion: full,
      });
      const boundDenies = await remintedFor({
        token: await tokenFor(['agents:*']),
        assertion: full,
      });
      const assertionDenies = await remintedFor({
        token: await tokenFor(reading),
        assertion: narrow,
      });

      expect(both.status).toBe(200);
      expect(boundDenies.status).toBe(403);
      expect(assertionDenies.status).toBe(403);
    });
  });

  describe('refusals', () => {
    test("a token another project's key issued is 400 project", async () => {
      const assertion = await assertionOf(projectKey);
      const token = await mintToken({
        key: otherProjectKey,
        actions: ['documents:GetDocument'],
      });

      const res = await readDocument(token, assertion);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ON_BEHALF_OF_INVALID');
      expect(res.body.error.meta).toEqual({ reason: 'project' });
    });

    test('a project-scoped token no key issued is 400 project', async () => {
      const assertion = await assertionOf(projectKey);
      const admin = jwt.decode(turn.adminToken) as { publicId: string };
      const oauthToken = signToken({
        typ: 'oauth',
        claims: {
          publicId: admin.publicId,
          role: 'admin',
          scope: `documents:* prj:${turn.projectId}`,
          prj: turn.projectId,
        },
        expiresIn: '1h',
      });

      const res = await readDocument(oauthToken, assertion);

      expect(res.status).toBe(400);
      expect(res.body.error.meta).toEqual({ reason: 'project' });
    });

    test('the project key itself is still admitted', async () => {
      const res = await readDocument(projectKey, await assertionOf(projectKey));

      expect(res.status).toBe(200);
    });
  });
});
