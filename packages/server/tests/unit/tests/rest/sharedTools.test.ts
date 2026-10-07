import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A tool project P shares with project Q through an accepted share: Q names it
 * like one of its own wherever a reference to a tool can be shared, it runs on
 * P's endpoint and secrets, and the call is metered in Q with P as publisher.
 */
describe('Shared tools', () => {
  let providerStub: Server;
  let toolStub: Server;
  let toolHits: IncomingHttpHeaders[];
  let providerBodies: Array<Record<string, unknown>>;
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;
  let aiProviderId: string;
  let sharedToolId: string;
  let shareId: string;
  let toolUrl: string;

  // Calls `sharedTool` once when a turn offers it, then answers in text.
  const startProviderStub = async (): Promise<string> => {
    providerStub = createServer((req, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        providerBodies.push(body);
        const offered = Array.isArray(body.tools)
          ? (body.tools as Array<{ name: string }>).map((tool) => {
              return tool.name;
            })
          : [];
        const answered = JSON.stringify(body.messages).includes('tool_result');
        const content =
          offered.includes('sharedTool') && !answered
            ? [
                {
                  type: 'tool_use',
                  id: 'toolu_shared',
                  name: 'sharedTool',
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

  /** A tool in P, shared with Q under `tools:CallTool`, not yet accepted. */
  const shareTool = async (name: string) => {
    const tool = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: publisherId,
        name,
        type: 'http',
        parameters: { type: 'object', properties: {} },
        execute: { url: toolUrl, method: 'POST' },
      });
    expect(tool.status).toBe(201);
    const share = await authenticatedTestClient(adminToken)
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: `srn:${publisherId}:tool:${tool.body.id}`,
        actions: ['tools:CallTool'],
        grantee: granteeId,
      });
    expect(share.status).toBe(201);
    return { toolId: tool.body.id as string, shareId: share.body.id as string };
  };

  const accept = async (id: string) => {
    const res = await authenticatedTestClient(granteeKey).post(
      `/api/v1/shares/${id}/accept`
    );
    expect(res.status).toBe(200);
  };

  const bindInQ = (toolId: string) => {
    return authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: granteeId,
        ai_provider_id: aiProviderId,
        model: 'claude-haiku-4-5',
        tool_bindings: [{ tool_id: toolId }],
      });
  };

  beforeAll(async () => {
    toolHits = [];
    providerBodies = [];
    const providerBaseUrl = await startProviderStub();
    toolUrl = await startToolStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'sharedtooladmin', password: 'supersecret' });
    adminToken = await loginAs('sharedtooladmin', 'supersecret');

    const publisher = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Publisher' });
    publisherId = publisher.body.id;
    const grantee = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Grantee' });
    granteeId = grantee.body.id;
    const key = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({ name: 'Grantee key', project_id: granteeId });
    granteeKey = key.body.key;

    const secret = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: granteeId, name: 'Provider Key', value: 'sk-ant' });
    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: granteeId,
        name: 'Stub Anthropic',
        provider: 'anthropic',
        default_model: 'claude-haiku-4-5',
        secret_id: secret.body.id,
        base_url: providerBaseUrl,
      });
    aiProviderId = provider.body.id;

    // The publisher's credential, which only a call running on P's side reads.
    const publisherSecret = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({
        project_id: publisherId,
        name: 'Publisher Token',
        value: 'publisher-token',
      });
    const tool = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: publisherId,
        name: 'sharedTool',
        type: 'http',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: toolUrl,
          method: 'POST',
          headers: {
            Authorization: `Bearer {{secret:${publisherSecret.body.id}}}`,
          },
        },
      });
    expect(tool.status).toBe(201);
    sharedToolId = tool.body.id;
    const share = await authenticatedTestClient(adminToken)
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: `srn:${publisherId}:tool:${sharedToolId}`,
        actions: ['tools:CallTool'],
        grantee: granteeId,
      });
    shareId = share.body.id;
    await accept(shareId);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      providerStub.close(() => {
        return resolve();
      });
    });
    await new Promise<void>((resolve) => {
      toolStub.close(() => {
        return resolve();
      });
    });
  });

  describe('references from the grantee', () => {
    test('an agent binds the shared tool', async () => {
      const response = await bindInQ(sharedToolId);

      expect(response.status).toBe(201);
      expect(response.body.tool_bindings).toEqual([{ tool_id: sharedToolId }]);
    });

    test('a share not yet accepted resolves nothing', async () => {
      const pending = await shareTool('pendingTool');

      const response = await bindInQ(pending.toolId);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test('a suspended share resolves nothing, and resume restores it', async () => {
      const paused = await shareTool('pausedTool');
      await accept(paused.shareId);
      await authenticatedTestClient(adminToken).post(
        `/api/v1/shares/${paused.shareId}/suspend`
      );

      const suspended = await bindInQ(paused.toolId);
      await authenticatedTestClient(adminToken).post(
        `/api/v1/shares/${paused.shareId}/resume`
      );
      const resumed = await bindInQ(paused.toolId);

      expect(suspended.status).toBe(400);
      expect(suspended.body.error.code).toBe('TOOL_NOT_FOUND');
      expect(resumed.status).toBe(201);
    });

    test('a revoked share resolves nothing', async () => {
      const revoked = await shareTool('revokedTool');
      await accept(revoked.shareId);
      await authenticatedTestClient(adminToken).post(
        `/api/v1/shares/${revoked.shareId}/revoke`
      );

      const response = await bindInQ(revoked.toolId);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test('a pipeline step names the shared tool', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: granteeId,
          name: 'granteePipeline',
          type: 'pipeline',
          parameters: { type: 'object', properties: {} },
          pipeline: { steps: [{ id: 'call', tool_id: sharedToolId }] },
        });

      expect(response.status).toBe(201);
    });

    test('a trigger targets the shared tool', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/triggers')
        .send({
          project_id: granteeId,
          name: 'shared-tool-trigger',
          type: 'manual',
          target_type: 'tool',
          target_id: sharedToolId,
        });

      expect(response.status).toBe(201);
    });

    test('an ingestion rule converts with the shared tool', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: granteeId,
          content_type_glob: 'image/png',
          tool_id: sharedToolId,
        });

      expect(response.status).toBe(201);
    });

    test("a decider's tool backend never resolves through a share", async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/deciders')
        .send({
          project_id: granteeId,
          name: 'shared-backend',
          tool_id: sharedToolId,
          questions: [
            {
              type: 'choice',
              name: 'route',
              instructions: 'Which team?',
              choices: [
                { value: 'billing', description: 'Money' },
                { value: 'technical', description: 'Errors' },
              ],
            },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
    });
  });

  describe('calls from the grantee', () => {
    const toolEvents = async () => {
      const res = await authenticatedTestClient(granteeKey)
        .get('/api/v1/usage/events')
        .query({ tool_id: sharedToolId, meter_type: 'tool_execution' });
      expect(res.status).toBe(200);
      return res.body.data as Array<Record<string, unknown>>;
    };

    test("a generation calls the shared tool on the publisher's secret, metered in the grantee", async () => {
      const agent = await bindInQ(sharedToolId);
      const conversation = await authenticatedTestClient(adminToken)
        .post('/api/v1/conversations')
        .send({ project_id: granteeId });
      await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${conversation.body.id}/messages`)
        .send({ role: 'user', message: 'go' });
      const before = toolHits.length;
      const eventsBefore = (await toolEvents()).length;

      const response = await authenticatedTestClient(adminToken)
        .post(
          `/api/v1/conversations/${conversation.body.id}/generate?wait=true`
        )
        .send({ agent_id: agent.body.id });

      expect(response.status).toBe(200);
      expect(toolHits.length).toBe(before + 1);
      expect(toolHits.at(-1)?.authorization).toBe('Bearer publisher-token');
      expect(toolHits.at(-1)?.['x-soat-context-calling_project_id']).toBe(
        granteeId
      );
      const events = await toolEvents();
      expect(events.length).toBe(eventsBefore + 1);
      expect(events[0].project_id).toBe(granteeId);
      expect(events[0].publisher_project_id).toBe(publisherId);
    });

    test('an orchestration tool node calls the shared tool', async () => {
      const orchestration = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: granteeId,
          name: 'Shared tool node',
          nodes: [{ id: 'call', type: 'tool', tool_id: sharedToolId }],
          edges: [],
        });
      expect(orchestration.status).toBe(201);
      const before = toolHits.length;

      const run = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestration.body.id, wait: true });

      expect(run.body.status).toBe('succeeded');
      expect(toolHits.length).toBe(before + 1);
      expect(toolHits.at(-1)?.['x-soat-context-calling_project_id']).toBe(
        granteeId
      );
    });

    test("the publisher's tool guardrail does not gate the grantee's call", async () => {
      const guardrail = await authenticatedTestClient(adminToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: publisherId,
          name: 'Publisher gate',
          document: { default_class: 'C', class: 'C' },
        });
      const gated = await shareTool('gatedTool');
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/tools/${gated.toolId}`)
        .send({ guardrail_ids: [guardrail.body.id] });
      await accept(gated.shareId);
      const orchestration = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: granteeId,
          name: 'Gated shared tool node',
          nodes: [{ id: 'call', type: 'tool', tool_id: gated.toolId }],
          edges: [],
        });
      const before = toolHits.length;

      const run = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestration.body.id, wait: true });

      expect(run.body.status).toBe('succeeded');
      expect(toolHits.length).toBe(before + 1);
    });
  });

  describe('GET /api/v1/usage/aggregate', () => {
    const aggregate = (publisherProjectId: string) => {
      return authenticatedTestClient(granteeKey)
        .get('/api/v1/usage/aggregate')
        .query({
          project_id: granteeId,
          meter_type: 'tool_execution',
          publisher_project_id: publisherProjectId,
        });
    };

    test("narrows to the calls on a publisher's resources", async () => {
      const response = await aggregate(publisherId);

      expect(response.status).toBe(200);
      expect(response.body.filters.publisher_project_id).toBe(publisherId);
      expect(response.body.totals.event_count).toBeGreaterThan(0);
    });

    test('a project the grantee never called through a share narrows to nothing', async () => {
      const response = await aggregate(granteeId);

      expect(response.status).toBe(200);
      expect(response.body.totals.event_count).toBe(0);
    });

    test('counts the distinct publishers the grantee called', async () => {
      const response = await authenticatedTestClient(granteeKey)
        .get('/api/v1/usage/aggregate')
        .query({ project_id: granteeId, include: 'distinct' });

      expect(response.status).toBe(200);
      expect(response.body.totals.distinct.publisher_projects).toBe(1);
    });
  });

  describe('formations in the grantee', () => {
    const deploy = (toolId: string, name: string) => {
      return authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: granteeId,
          name,
          template: {
            resources: {
              Rule: {
                type: 'ingestion_rule',
                properties: {
                  content_type_glob: `audio/x-${name}`,
                  tool_id: toolId,
                },
              },
            },
          },
        });
    };

    test('a template names a shared tool, and fails naming it once the share is revoked', async () => {
      const shared = await shareTool('formationTool');
      await accept(shared.shareId);

      const deployed = await deploy(shared.toolId, 'shared-ok');
      await authenticatedTestClient(adminToken).post(
        `/api/v1/shares/${shared.shareId}/revoke`
      );
      const refused = await deploy(shared.toolId, 'shared-gone');

      expect(deployed.status).toBe(201);
      expect(deployed.body.status).toBe('active');
      expect(refused.body.status).toBe('failed');
      expect(refused.body.error.message).toBe(
        `Tool not found: ${shared.toolId}`
      );
    });
  });

  describe('when the share goes away', () => {
    test('a converter behind a revoked share fails the document', async () => {
      const gone = await shareTool('goneConverter');
      await accept(gone.shareId);
      const rule = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: granteeId,
          content_type_glob: 'audio/x-shared-gone',
          tool_id: gone.toolId,
        });
      expect(rule.status).toBe(201);
      await authenticatedTestClient(adminToken).post(
        `/api/v1/shares/${gone.shareId}/revoke`
      );
      const file = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('bytes'), {
          filename: 'gone.bin',
          contentType: 'audio/x-shared-gone',
        })
        .field('project_id', granteeId);

      const ingest = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?wait=true')
        .send({ project_id: granteeId, file_id: file.body.id });

      expect(ingest.body.status).toBe('failed');
      const status = await authenticatedTestClient(adminToken).get(
        `/api/v1/documents/${ingest.body.id}/status`
      );
      expect(status.body.error).toBe('CONVERTER_FAILED');
    });

    test("an agent's binding drops, the turn is told, and the feed records why", async () => {
      const gone = await shareTool('goneTool');
      await accept(gone.shareId);
      const agent = await bindInQ(gone.toolId);
      await authenticatedTestClient(adminToken).post(
        `/api/v1/shares/${gone.shareId}/revoke`
      );
      const before = toolHits.length;

      const response = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agent.body.id}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'go' }] });

      expect(response.status).toBe(200);
      expect(toolHits.length).toBe(before);
      expect(JSON.stringify(providerBodies.at(-1)?.system)).toContain(
        gone.toolId
      );
      const feed = await authenticatedTestClient(adminToken)
        .get('/api/v1/activity')
        .query({ project_id: granteeId, kind: 'tool_resolution_failed' });
      expect(
        (feed.body.data as Array<{ agent_id: string }>).some((entry) => {
          return entry.agent_id === agent.body.id;
        })
      ).toBe(true);
    });
  });
});
