import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The routes a grantee reaches a shared tool or agent through by its id: a
 * key scoped to the grantee project reads the consumer projection and calls
 * the tool, and the call is metered in the grantee with the publisher named.
 */
describe('Shared resources on their own routes', () => {
  let toolStub: Server;
  let toolHits: IncomingHttpHeaders[];
  let toolUrl: string;
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;
  let sharedToolId: string;
  let sharedAgentId: string;

  const startToolStub = async (): Promise<string> => {
    toolStub = createServer((req, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        toolHits.push(req.headers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      toolStub.listen(0, '127.0.0.1', resolve);
    });
    const { port } = toolStub.address() as AddressInfo;
    return `http://127.0.0.1:${port}/hook`;
  };

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const grantee = () => {
    return authenticatedTestClient(granteeKey);
  };

  /** A resource of P shared with Q; accepted unless `accept` is false. */
  const share = async (args: {
    type: 'tool' | 'agent';
    id: string;
    action: string;
    accept?: boolean;
  }) => {
    const created = await admin()
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: `srn:${publisherId}:${args.type}:${args.id}`,
        actions: [args.action],
        grantee: granteeId,
      });
    expect(created.status).toBe(201);
    if (args.accept !== false) {
      const accepted = await grantee().post(
        `/api/v1/shares/${created.body.id}/accept`
      );
      expect(accepted.status).toBe(200);
    }
    return created.body.id as string;
  };

  const createPublisherTool = async (name: string) => {
    const tool = await admin()
      .post('/api/v1/tools')
      .send({
        project_id: publisherId,
        name,
        type: 'http',
        parameters: { type: 'object', properties: {} },
        execute: { url: toolUrl, method: 'POST' },
      });
    expect(tool.status).toBe(201);
    return tool.body.id as string;
  };

  const granteeEvents = async () => {
    const res = await grantee()
      .get('/api/v1/usage/events')
      .query({ meter_type: 'tool_execution' });
    expect(res.status).toBe(200);
    return res.body.data as Array<Record<string, unknown>>;
  };

  beforeAll(async () => {
    toolHits = [];
    toolUrl = await startToolStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'shareddirectadmin', password: 'supersecret' });
    adminToken = await loginAs('shareddirectadmin', 'supersecret');

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

    sharedToolId = await createPublisherTool('directTool');
    await share({ type: 'tool', id: sharedToolId, action: 'tools:CallTool' });

    const provider = await admin().post('/api/v1/ai-providers').send({
      project_id: publisherId,
      name: 'Publisher Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: 'http://127.0.0.1:9',
    });
    const agent = await admin().post('/api/v1/agents').send({
      project_id: publisherId,
      ai_provider_id: provider.body.id,
      name: 'Shared Agent',
      instructions: 'The publisher prompt.',
    });
    sharedAgentId = agent.body.id;
    await share({
      type: 'agent',
      id: sharedAgentId,
      action: 'agents:CreateAgentGeneration',
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      toolStub.close(() => {
        return resolve();
      });
    });
  });

  describe('POST /api/v1/tools/:tool_id/call', () => {
    test('the grantee calls the shared tool, metered in its own project', async () => {
      const before = toolHits.length;

      const response = await grantee()
        .post(`/api/v1/tools/${sharedToolId}/call`)
        .send({ input: {} });

      expect(response.status).toBe(200);
      expect(toolHits.length).toBe(before + 1);
      const events = (await granteeEvents()).filter((event) => {
        return event.tool_id === sharedToolId;
      });
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].project_id).toBe(granteeId);
      expect(events[0].publisher_project_id).toBe(publisherId);
    });

    test('the tool receives the calling project, and a caller cannot forge it', async () => {
      await grantee()
        .post(`/api/v1/tools/${sharedToolId}/call`)
        .send({
          input: {},
          tool_context: { calling_project_id: 'proj_forged' },
        });

      expect(toolHits.at(-1)?.['x-soat-context-calling_project_id']).toBe(
        granteeId
      );
    });

    test("a call in the tool's own project names no calling project", async () => {
      await admin()
        .post(`/api/v1/tools/${sharedToolId}/call`)
        .send({
          input: {},
          tool_context: { calling_project_id: 'proj_forged' },
        });

      expect(
        toolHits.at(-1)?.['x-soat-context-calling_project_id']
      ).toBeUndefined();
    });

    test('a share not yet accepted is refused, and nothing is metered', async () => {
      const pendingToolId = await createPublisherTool('pendingDirectTool');
      await share({
        type: 'tool',
        id: pendingToolId,
        action: 'tools:CallTool',
        accept: false,
      });
      const before = (await granteeEvents()).length;

      const response = await grantee()
        .post(`/api/v1/tools/${pendingToolId}/call`)
        .send({ input: {} });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('API_KEY_PROJECT_SCOPE');
      expect((await granteeEvents()).length).toBe(before);
    });
  });

  describe('GET /api/v1/tools/:tool_id', () => {
    test('the grantee reads the consumer projection only', async () => {
      const response = await grantee().get(`/api/v1/tools/${sharedToolId}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: sharedToolId,
        name: 'directTool',
        description: null,
        parameters: { type: 'object', properties: {} },
      });
    });

    test('the grantee cannot change the shared tool', async () => {
      const response = await grantee()
        .patch(`/api/v1/tools/${sharedToolId}`)
        .send({ description: 'taken over' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('API_KEY_PROJECT_SCOPE');
    });
  });

  describe('GET /api/v1/agents/:agent_id', () => {
    test('the grantee reads the consumer projection only', async () => {
      const response = await grantee().get(`/api/v1/agents/${sharedAgentId}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: sharedAgentId,
        name: 'Shared Agent',
      });
    });

    test('the grantee cannot change the shared agent', async () => {
      const response = await grantee()
        .patch(`/api/v1/agents/${sharedAgentId}`)
        .send({ instructions: 'taken over' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('API_KEY_PROJECT_SCOPE');
    });
  });
});
