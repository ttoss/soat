import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * An agent project P shares with project Q: Q runs it wherever it names an
 * agent. The turn runs on P's configuration — its instructions, provider and
 * tools — and every record of it (generation, trace, usage) lands in Q.
 */
describe('Shared agents', () => {
  let providerStub: Server;
  let providerCalls: Array<{
    headers: IncomingHttpHeaders;
    body: Record<string, unknown>;
  }>;
  let toolStub: Server;
  let toolHits: IncomingHttpHeaders[];
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;
  let publisherProviderId: string;
  let publisherToolId: string;
  let sharedAgentId: string;

  // Calls `ownerTool` once when a turn offers it, then answers in text.
  const startProviderStub = async (): Promise<string> => {
    providerStub = createServer((req, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        providerCalls.push({ headers: req.headers, body });
        const offered = Array.isArray(body.tools)
          ? (body.tools as Array<{ name: string }>).map((tool) => {
              return tool.name;
            })
          : [];
        const answered = JSON.stringify(body.messages).includes('tool_result');
        const content =
          offered.includes('ownerTool') && !answered
            ? [
                {
                  type: 'tool_use',
                  id: 'toolu_owner',
                  name: 'ownerTool',
                  input: {},
                },
              ]
            : [{ type: 'text', text: 'shared answer' }];
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

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const grantee = () => {
    return authenticatedTestClient(granteeKey);
  };

  /** A new agent in P on the shared provider, shared with Q and accepted. */
  const shareAgent = async (name: string) => {
    const agent = await admin()
      .post('/api/v1/agents')
      .send({
        project_id: publisherId,
        name,
        ai_provider_id: publisherProviderId,
        model: 'claude-haiku-4-5',
        instructions: `The ${name} publisher prompt.`,
      });
    expect(agent.status).toBe(201);
    const share = await admin()
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: `srn:${publisherId}:agent:${agent.body.id}`,
        actions: ['agents:CreateAgentGeneration'],
        grantee: granteeId,
      });
    expect(share.status).toBe(201);
    const accepted = await grantee().post(
      `/api/v1/shares/${share.body.id}/accept`
    );
    expect(accepted.status).toBe(200);
    return {
      agentId: agent.body.id as string,
      shareId: share.body.id as string,
    };
  };

  const generate = (agentId: string) => {
    return grantee()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
  };

  beforeAll(async () => {
    providerCalls = [];
    toolHits = [];
    const providerBaseUrl = await startProviderStub();
    const toolUrl = await startToolStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'sharedagentadmin', password: 'supersecret' });
    adminToken = await loginAs('sharedagentadmin', 'supersecret');

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

    const secret = await admin().post('/api/v1/secrets').send({
      project_id: publisherId,
      name: 'Publisher Provider Key',
      value: 'sk-publisher',
    });
    const provider = await admin().post('/api/v1/ai-providers').send({
      project_id: publisherId,
      name: 'Publisher Anthropic',
      provider: 'anthropic',
      default_model: 'claude-haiku-4-5',
      secret_id: secret.body.id,
      base_url: providerBaseUrl,
    });
    publisherProviderId = provider.body.id;

    const tool = await admin()
      .post('/api/v1/tools')
      .send({
        project_id: publisherId,
        name: 'ownerTool',
        type: 'http',
        parameters: { type: 'object', properties: {} },
        execute: { url: toolUrl, method: 'POST' },
      });
    publisherToolId = tool.body.id;

    const agent = await admin()
      .post('/api/v1/agents')
      .send({
        project_id: publisherId,
        name: 'Shared Agent',
        ai_provider_id: publisherProviderId,
        model: 'claude-haiku-4-5',
        instructions: 'The publisher prompt.',
        tool_bindings: [{ tool_id: publisherToolId }],
      });
    sharedAgentId = agent.body.id;
    const share = await admin()
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: `srn:${publisherId}:agent:${sharedAgentId}`,
        actions: ['agents:CreateAgentGeneration'],
        grantee: granteeId,
      });
    await grantee().post(`/api/v1/shares/${share.body.id}/accept`);
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

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test("the grantee runs the agent on the publisher's configuration", async () => {
      const before = providerCalls.length;

      const response = await generate(sharedAgentId);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');
      const call = providerCalls[before];
      expect(call.headers['x-api-key']).toBe('sk-publisher');
      expect(JSON.stringify(call.body.system)).toContain(
        'The publisher prompt.'
      );
    });

    test('the generation is recorded in the grantee project', async () => {
      const response = await generate(sharedAgentId);

      const generation = await grantee().get(
        `/api/v1/generations/${response.body.id}`
      );
      expect(generation.status).toBe(200);
      expect(generation.body.project_id).toBe(granteeId);
      expect(generation.body.agent_id).toBe(sharedAgentId);
    });

    test("the agent's own tool runs as a call through the share", async () => {
      const before = toolHits.length;

      await generate(sharedAgentId);

      expect(toolHits.length).toBe(before + 1);
      expect(toolHits.at(-1)?.['x-soat-context-calling_project_id']).toBe(
        granteeId
      );
    });

    test('the turn is metered in the grantee, naming the publisher and its provider', async () => {
      const response = await generate(sharedAgentId);

      const events = await grantee().get('/api/v1/usage/events').query({
        meter_type: 'llm_tokens',
        generation_id: response.body.id,
      });
      expect(events.status).toBe(200);
      expect(events.body.data.length).toBeGreaterThan(0);
      expect(events.body.data[0]).toMatchObject({
        project_id: granteeId,
        publisher_project_id: publisherId,
        ai_provider_id: publisherProviderId,
        agent_id: sharedAgentId,
      });
    });

    test("the usage events narrow on the shared agent's id", async () => {
      const response = await generate(sharedAgentId);

      const events = await grantee().get('/api/v1/usage/events').query({
        meter_type: 'llm_tokens',
        agent_id: sharedAgentId,
      });

      expect(events.status).toBe(200);
      expect(
        events.body.data.map((event: { generation_id: string }) => {
          return event.generation_id;
        })
      ).toContain(response.body.id);
    });

    test("the usage aggregate narrows on the shared agent's id", async () => {
      await generate(sharedAgentId);

      const aggregate = await grantee()
        .get('/api/v1/usage/aggregate')
        .query({ project_id: granteeId, agent_id: sharedAgentId });

      expect(aggregate.status).toBe(200);
      expect(aggregate.body.totals.event_count).toBeGreaterThan(0);
    });

    test("the generation listing narrows on the shared agent's id", async () => {
      const response = await generate(sharedAgentId);

      const generations = await grantee()
        .get('/api/v1/generations')
        .query({ agent_id: sharedAgentId });

      expect(generations.status).toBe(200);
      expect(
        generations.body.data.map((generation: { id: string }) => {
          return generation.id;
        })
      ).toContain(response.body.id);
    });
  });

  describe('agent references in the grantee', () => {
    test('a conversation generates with the shared agent', async () => {
      const conversation = await admin()
        .post('/api/v1/conversations')
        .send({ project_id: granteeId });
      await admin()
        .post(`/api/v1/conversations/${conversation.body.id}/messages`)
        .send({ role: 'user', message: 'hi' });

      const response = await admin()
        .post(
          `/api/v1/conversations/${conversation.body.id}/generate?wait=true`
        )
        .send({ agent_id: sharedAgentId });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');
    });

    test('a session in the grantee runs the shared agent', async () => {
      const session = await grantee()
        .post('/api/v1/sessions')
        .send({ agent_id: sharedAgentId });
      expect(session.status).toBe(201);
      await grantee()
        .post(`/api/v1/sessions/${session.body.id}/messages`)
        .send({ message: 'hi' });

      const response = await grantee().post(
        `/api/v1/sessions/${session.body.id}/generate?wait=true`
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');
    });

    test('an orchestration agent node runs the shared agent', async () => {
      const orchestration = await admin()
        .post('/api/v1/orchestrations')
        .send({
          project_id: granteeId,
          name: 'Shared agent node',
          nodes: [{ id: 'ask', type: 'agent', agent_id: sharedAgentId }],
          edges: [],
        });
      expect(orchestration.status).toBe(201);

      const run = await admin()
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestration.body.id, wait: true });

      expect(run.body.status).toBe('succeeded');
    });

    test('an ingestion rule converts with the shared agent', async () => {
      const rule = await admin().post('/api/v1/ingestion-rules').send({
        project_id: granteeId,
        content_type_glob: 'image/x-shared-agent',
        agent_id: sharedAgentId,
      });
      expect(rule.status).toBe(201);
      const file = await admin()
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('bytes'), {
          filename: 'scan.bin',
          contentType: 'image/x-shared-agent',
        })
        .field('project_id', granteeId);

      const ingest = await admin()
        .post('/api/v1/documents/ingest?wait=true')
        .send({ project_id: granteeId, file_id: file.body.id });

      expect(ingest.body.status).toBe('ready');
    });
  });

  describe('formations in the grantee', () => {
    const deploy = (agentId: string, name: string) => {
      return admin()
        .post('/api/v1/formations')
        .send({
          project_id: granteeId,
          name,
          template: {
            resources: {
              Rule: {
                type: 'ingestion_rule',
                properties: {
                  content_type_glob: `image/x-${name}`,
                  agent_id: agentId,
                },
              },
            },
          },
        });
    };

    test('a template declares a rule converting with the shared agent, and fails naming it once the share is revoked', async () => {
      const shared = await shareAgent('Formation Converter');

      const deployed = await deploy(shared.agentId, 'agent-rule-ok');
      await admin().post(`/api/v1/shares/${shared.shareId}/revoke`);
      const refused = await deploy(shared.agentId, 'agent-rule-gone');

      expect(deployed.status).toBe(201);
      expect(deployed.body.status).toBe('active');
      expect(refused.body.status).toBe('failed');
      expect(refused.body.error.message).toContain(shared.agentId);
    });
  });

  describe('when the share goes away', () => {
    test('the grantee can no longer run the agent', async () => {
      const gone = await shareAgent('Revoked Agent');
      await admin().post(`/api/v1/shares/${gone.shareId}/revoke`);

      const response = await generate(gone.agentId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('API_KEY_PROJECT_SCOPE');
    });

    test("deleting the publisher's agent keeps the grantee's records", async () => {
      const deleted = await shareAgent('Deleted Agent');
      const session = await grantee()
        .post('/api/v1/sessions')
        .send({ agent_id: deleted.agentId });
      const turn = await generate(deleted.agentId);

      const removed = await admin().delete(
        `/api/v1/agents/${deleted.agentId}?force=true`
      );
      expect(removed.status).toBe(204);

      const generation = await grantee().get(
        `/api/v1/generations/${turn.body.id}`
      );
      expect(generation.status).toBe(200);
      expect(generation.body.agent_id).toBe(deleted.agentId);
      const kept = await grantee().get(`/api/v1/sessions/${session.body.id}`);
      expect(kept.status).toBe(200);
      expect(kept.body.agent_id).toBe(deleted.agentId);
      await grantee()
        .post(`/api/v1/sessions/${session.body.id}/messages`)
        .send({ message: 'still there?' });
      const orphaned = await grantee().post(
        `/api/v1/sessions/${session.body.id}/generate?wait=true`
      );
      expect(orphaned.status).toBe(400);
      expect(orphaned.body.error.code).toBe('AGENT_NOT_FOUND');
    });
  });
});
