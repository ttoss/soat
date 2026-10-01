import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createScopedPrincipal } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A share's `cap` bounds how many calls each accepting project makes through
 * it in a window. A refused call reaches nothing, so it is not metered; the
 * consumer project's activity feed records it.
 */
describe('Share caps', () => {
  let providerStub: Server;
  let toolStub: Server;
  let toolHits: number;
  let providerBodies: Array<Record<string, unknown>>;
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;
  let granteeProviderId: string;
  let publisherProviderId: string;
  let toolUrl: string;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const grantee = () => {
    return authenticatedTestClient(granteeKey);
  };

  // Calls the first tool a turn offers, then answers in text.
  const startProviderStub = async (): Promise<string> => {
    providerStub = createServer((req, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        providerBodies.push(body);
        const [offered] = Array.isArray(body.tools)
          ? (body.tools as Array<{ name: string }>)
          : [];
        const answered = JSON.stringify(body.messages).includes('tool_result');
        const content =
          offered && !answered
            ? [
                {
                  type: 'tool_use',
                  id: 'toolu_capped',
                  name: offered.name,
                  input: {},
                },
              ]
            : [{ type: 'text', text: 'done' }];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-4-5',
            content,
            stop_reason:
              content[0].type === 'tool_use' ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 2 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      providerStub.listen(0, '127.0.0.1', resolve);
    });
    const { port } = providerStub.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const startToolStub = async (): Promise<string> => {
    toolStub = createServer((req, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        toolHits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'converted' }));
      });
    });
    await new Promise<void>((resolve) => {
      toolStub.listen(0, '127.0.0.1', resolve);
    });
    const { port } = toolStub.address() as AddressInfo;
    return `http://127.0.0.1:${port}/hook`;
  };

  const createProvider = async (args: {
    projectId: string;
    baseUrl: string;
  }) => {
    const secret = await admin()
      .post('/api/v1/secrets')
      .send({ project_id: args.projectId, name: 'Provider Key', value: 'k' });
    const provider = await admin().post('/api/v1/ai-providers').send({
      project_id: args.projectId,
      name: 'Stub Anthropic',
      provider: 'anthropic',
      default_model: 'claude-haiku-4-5',
      secret_id: secret.body.id,
      base_url: args.baseUrl,
    });
    expect(provider.status).toBe(201);
    return provider.body.id as string;
  };

  /** A tool of P shared with Q under `cap`, accepted by Q. */
  const shareTool = async (args: {
    name: string;
    cap?: { calls: number; window: string };
  }) => {
    const tool = await admin()
      .post('/api/v1/tools')
      .send({
        project_id: publisherId,
        name: args.name,
        type: 'http',
        parameters: { type: 'object', properties: {} },
        execute: { url: toolUrl, method: 'POST' },
      });
    expect(tool.status).toBe(201);
    const share = await admin()
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: `srn:${publisherId}:tool:${tool.body.id}`,
        actions: ['tools:CallTool'],
        grantee: granteeId,
        ...(args.cap ? { cap: args.cap } : {}),
      });
    expect(share.status).toBe(201);
    const accepted = await grantee().post(
      `/api/v1/shares/${share.body.id}/accept`
    );
    expect(accepted.status).toBe(200);
    return { toolId: tool.body.id as string, shareId: share.body.id as string };
  };

  const callAsGrantee = (toolId: string) => {
    return grantee().post(`/api/v1/tools/${toolId}/call`).send({ input: {} });
  };

  const capExceededEntries = async () => {
    const res = await admin()
      .get('/api/v1/activity')
      .query({ project_id: granteeId, kind: 'share_cap_exceeded' });
    expect(res.status).toBe(200);
    return res.body.data as Array<{ ref_id: string }>;
  };

  const meteredCalls = async (toolId: string) => {
    const res = await grantee()
      .get('/api/v1/usage/events')
      .query({ meter_type: 'tool_execution' });
    expect(res.status).toBe(200);
    return (res.body.data as Array<{ tool_id: string }>).filter((event) => {
      return event.tool_id === toolId;
    }).length;
  };

  beforeAll(async () => {
    toolHits = 0;
    providerBodies = [];
    const providerBaseUrl = await startProviderStub();
    toolUrl = await startToolStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'sharecapadmin', password: 'supersecret' });
    adminToken = await loginAs('sharecapadmin', 'supersecret');

    publisherId = (
      await admin().post('/api/v1/projects').send({ name: 'Publisher' })
    ).body.id;
    granteeId = (
      await admin().post('/api/v1/projects').send({ name: 'Grantee' })
    ).body.id;
    granteeKey = (
      await admin()
        .post('/api/v1/api-keys')
        .send({ name: 'Grantee key', project_id: granteeId })
    ).body.key;
    granteeProviderId = await createProvider({
      projectId: granteeId,
      baseUrl: providerBaseUrl,
    });
    publisherProviderId = await createProvider({
      projectId: publisherId,
      baseUrl: providerBaseUrl,
    });
  });

  afterAll(async () => {
    await Promise.all(
      [providerStub, toolStub].map((server) => {
        return new Promise<void>((resolve) => {
          server.close(() => {
            return resolve();
          });
        });
      })
    );
  });

  describe('POST /api/v1/shares', () => {
    test('stores the cap', async () => {
      const tool = await admin().post('/api/v1/tools').send({
        project_id: publisherId,
        name: 'storedCapTool',
        type: 'client',
      });

      const response = await admin()
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: `srn:${publisherId}:tool:${tool.body.id}`,
          actions: ['tools:CallTool'],
          grantee: granteeId,
          cap: { calls: 10, window: 'rolling_1h' },
        });

      expect(response.status).toBe(201);
      expect(response.body.cap).toEqual({ calls: 10, window: 'rolling_1h' });
    });

    test.each([
      [{ calls: 0, window: 'rolling_1h' }],
      [{ calls: 10, window: 'current' }],
    ])('refuses the cap %o', async (cap) => {
      const tool = await admin()
        .post('/api/v1/tools')
        .send({
          project_id: publisherId,
          name: `badCap${String(cap.calls)}${cap.window}`,
          type: 'client',
        });

      const response = await admin()
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: `srn:${publisherId}:tool:${tool.body.id}`,
          actions: ['tools:CallTool'],
          grantee: granteeId,
          cap,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PATCH /api/v1/shares/:share_id', () => {
    test('the publisher sets and clears the cap', async () => {
      const { shareId } = await shareTool({ name: 'patchedCapTool' });

      const set = await admin()
        .patch(`/api/v1/shares/${shareId}`)
        .send({ cap: { calls: 5, window: 'rolling_24h' } });
      const cleared = await admin()
        .patch(`/api/v1/shares/${shareId}`)
        .send({ cap: null });

      expect(set.status).toBe(200);
      expect(set.body.cap).toEqual({ calls: 5, window: 'rolling_24h' });
      expect(cleared.status).toBe(200);
      expect(cleared.body.cap).toBeNull();
    });

    test('the grantee cannot change it', async () => {
      const { shareId } = await shareTool({ name: 'granteePatchTool' });

      const response = await grantee()
        .patch(`/api/v1/shares/${shareId}`)
        .send({ cap: null });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('API_KEY_PROJECT_SCOPE');
    });

    test('a publisher principal without UpdateShare gets 403', async () => {
      const { shareId } = await shareTool({ name: 'forbiddenPatchTool' });
      const token = await createScopedPrincipal({
        adminToken,
        projectId: publisherId,
        username: 'sharecapreader',
        actions: ['shares:GetShare'],
      });

      const response = await authenticatedTestClient(token)
        .patch(`/api/v1/shares/${shareId}`)
        .send({ cap: null });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch('/api/v1/shares/shr_x')
        .send({ cap: null });

      expect(response.status).toBe(401);
    });
  });

  describe('a direct call past the cap', () => {
    test('is 429 with retry_after, reaches nothing and is not metered', async () => {
      const { toolId, shareId } = await shareTool({
        name: 'directCapTool',
        cap: { calls: 2, window: 'rolling_24h' },
      });
      expect((await callAsGrantee(toolId)).status).toBe(200);
      expect((await callAsGrantee(toolId)).status).toBe(200);
      const hits = toolHits;

      const refused = await callAsGrantee(toolId);

      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('SHARE_CAP_EXCEEDED');
      expect(refused.body.error.meta.retry_after).toBeGreaterThan(0);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(toolHits).toBe(hits);
      expect(await meteredCalls(toolId)).toBe(2);
      expect(
        (await capExceededEntries()).some((entry) => {
          return entry.ref_id === shareId;
        })
      ).toBe(true);
    });

    test("never refuses the publisher's own call", async () => {
      const { toolId } = await shareTool({
        name: 'ownCallCapTool',
        cap: { calls: 1, window: 'rolling_24h' },
      });
      await callAsGrantee(toolId);

      const response = await admin()
        .post(`/api/v1/tools/${toolId}/call`)
        .send({ input: {} });

      expect(response.status).toBe(200);
    });

    test('is admitted once the cap is raised', async () => {
      const { toolId, shareId } = await shareTool({
        name: 'raisedCapTool',
        cap: { calls: 1, window: 'rolling_24h' },
      });
      await callAsGrantee(toolId);
      expect((await callAsGrantee(toolId)).status).toBe(429);

      await admin()
        .patch(`/api/v1/shares/${shareId}`)
        .send({ cap: { calls: 2, window: 'rolling_24h' } });

      expect((await callAsGrantee(toolId)).status).toBe(200);
    });

    test('is admitted once the window resets', async () => {
      const { toolId } = await shareTool({
        name: 'resetCapTool',
        cap: { calls: 1, window: 'rolling_1m' },
      });
      jest.useFakeTimers({ advanceTimers: true });
      try {
        await callAsGrantee(toolId);
        expect((await callAsGrantee(toolId)).status).toBe(429);

        jest.setSystemTime(Date.now() + 61_000);

        expect((await callAsGrantee(toolId)).status).toBe(200);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('inside a generation', () => {
    test('the refused call is a tool error and the turn completes', async () => {
      const { toolId, shareId } = await shareTool({
        name: 'generationCapTool',
        cap: { calls: 1, window: 'rolling_24h' },
      });
      await callAsGrantee(toolId);
      const agent = await admin()
        .post('/api/v1/agents')
        .send({
          project_id: granteeId,
          ai_provider_id: granteeProviderId,
          model: 'claude-haiku-4-5',
          tool_bindings: [{ tool_id: toolId }],
        });
      const hits = toolHits;

      const response = await admin()
        .post(`/api/v1/agents/${agent.body.id}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'go' }] });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');
      expect(toolHits).toBe(hits);
      expect(JSON.stringify(providerBodies.at(-1)?.messages)).toContain(
        shareId
      );
    });
  });

  describe('as an ingestion converter', () => {
    test('the document fails with CONVERTER_FAILED', async () => {
      const { toolId } = await shareTool({
        name: 'converterCapTool',
        cap: { calls: 1, window: 'rolling_24h' },
      });
      await callAsGrantee(toolId);
      await admin().post('/api/v1/ingestion-rules').send({
        project_id: granteeId,
        content_type_glob: 'audio/x-capped',
        tool_id: toolId,
      });
      const file = await admin()
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('bytes'), {
          filename: 'capped.bin',
          contentType: 'audio/x-capped',
        })
        .field('project_id', granteeId);
      const hits = toolHits;

      const ingest = await admin()
        .post('/api/v1/documents/ingest?wait=true')
        .send({ project_id: granteeId, file_id: file.body.id });

      expect(ingest.body.status).toBe('failed');
      const status = await admin().get(
        `/api/v1/documents/${ingest.body.id}/status`
      );
      expect(status.body.error).toBe('CONVERTER_FAILED');
      expect(toolHits).toBe(hits);
    });
  });

  describe('a shared agent', () => {
    test('a turn past the cap is 429', async () => {
      const agent = await admin().post('/api/v1/agents').send({
        project_id: publisherId,
        ai_provider_id: publisherProviderId,
        name: 'Capped Agent',
        model: 'claude-haiku-4-5',
      });
      const share = await admin()
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: `srn:${publisherId}:agent:${agent.body.id}`,
          actions: ['agents:CreateAgentGeneration'],
          grantee: granteeId,
          cap: { calls: 1, window: 'rolling_24h' },
        });
      await grantee().post(`/api/v1/shares/${share.body.id}/accept`);
      const generate = () => {
        return grantee()
          .post(`/api/v1/agents/${agent.body.id}/generate?wait=true`)
          .send({ messages: [{ role: 'user', content: 'hi' }] });
      };
      expect((await generate()).status).toBe(200);

      const refused = await generate();

      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('SHARE_CAP_EXCEEDED');
    });
  });
});
