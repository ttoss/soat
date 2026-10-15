import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * `max_output_tokens` and `reasoning`, end to end: what the agent stores, and
 * what reaches the provider. Asserted on the wire against a stub Anthropic
 * endpoint, since a setting that is stored but never sent reads correctly on
 * every surface above it.
 */
describe('Agent model settings (max_output_tokens, reasoning)', () => {
  let stubServer: Server;
  let requestBodies: Array<Record<string, unknown>>;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let aiProviderId: string;

  const anthropicResponse = {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 2 },
  };

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requestBodies.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(anthropicResponse));
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const createAgent = (body: Record<string, unknown>) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        model: 'claude-sonnet-4-5',
        ...body,
      });
  };

  /** Generates once and returns the body the provider received. */
  const sentToProvider = async (agentId: string) => {
    requestBodies = [];
    const response = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBe(200);
    expect(requestBodies).toHaveLength(1);
    return requestBodies[0];
  };

  beforeAll(async () => {
    requestBodies = [];
    const stubBaseUrl = await startStubServer();

    const setup = await setupProjectWithUsers({
      prefix: 'agentmodelsettings',
      policyActions: [
        'agents:CreateAgent',
        'agents:UpdateAgent',
        'agents:GetAgent',
        'agents:CreateAgentGeneration',
        'secrets:CreateSecret',
      ],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;

    const secret = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'Stub Key', value: 'sk-ant-stub' });

    const provider = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Stub Anthropic',
        provider: 'anthropic',
        default_model: 'claude-sonnet-4-5',
        secret_id: secret.body.id,
        base_url: stubBaseUrl,
      });
    aiProviderId = provider.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        return resolve();
      });
    });
  });

  describe('POST /api/v1/agents', () => {
    test('both default to null, and nothing is sent', async () => {
      const agent = await createAgent({ name: 'Defaults' });

      expect(agent.status).toBe(201);
      expect(agent.body.max_output_tokens).toBeNull();
      expect(agent.body.reasoning).toBeNull();

      const sent = await sentToProvider(agent.body.id);
      expect(sent.thinking).toBeUndefined();
    });

    test('max_output_tokens caps the response', async () => {
      const agent = await createAgent({ max_output_tokens: 256 });

      expect(agent.status).toBe(201);
      expect(agent.body.max_output_tokens).toBe(256);

      const sent = await sentToProvider(agent.body.id);
      expect(sent.max_tokens).toBe(256);
    });

    test.each(['low', 'medium', 'high'])(
      'reasoning effort %s turns thinking on',
      async (effort) => {
        const agent = await createAgent({ reasoning: { effort } });

        expect(agent.status).toBe(201);
        expect(agent.body.reasoning).toEqual({ effort });

        const sent = await sentToProvider(agent.body.id);
        expect(sent.thinking).toEqual(
          expect.objectContaining({
            type: expect.not.stringMatching('disabled'),
          })
        );
      }
    );

    test('reasoning effort none turns thinking off', async () => {
      const agent = await createAgent({ reasoning: { effort: 'none' } });

      const sent = await sentToProvider(agent.body.id);

      expect(sent.thinking).toEqual({ type: 'disabled' });
    });

    test.each([
      ['max_output_tokens', 0],
      ['max_output_tokens', -5],
      ['max_output_tokens', 1.5],
      ['reasoning', { effort: 'extreme' }],
      ['reasoning', { effort: 'low', budget_tokens: 1000 }],
      ['reasoning', {}],
      ['reasoning', 'low'],
    ])('%s %j is 400', async (field, value) => {
      const response = await createAgent({ [field]: value });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('401 without credentials', async () => {
      const response = await testClient.post('/api/v1/agents').send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        max_output_tokens: 256,
      });

      expect(response.status).toBe(401);
    });

    test('403 without CreateAgent', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          reasoning: { effort: 'low' },
        });

      expect(response.status).toBe(403);
    });
  });

  describe('PATCH /api/v1/agents/:agent_id', () => {
    test('sets both, and null clears them', async () => {
      const agent = await createAgent({ name: 'Patched' });

      const set = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agent.body.id}`)
        .send({ max_output_tokens: 512, reasoning: { effort: 'high' } });
      expect(set.status).toBe(200);
      expect(set.body.max_output_tokens).toBe(512);
      expect(set.body.reasoning).toEqual({ effort: 'high' });

      const cleared = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agent.body.id}`)
        .send({ max_output_tokens: null, reasoning: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.max_output_tokens).toBeNull();
      expect(cleared.body.reasoning).toBeNull();

      const sent = await sentToProvider(agent.body.id);
      expect(sent.thinking).toBeUndefined();
    });

    test('an invalid effort is 400 and changes nothing', async () => {
      const agent = await createAgent({ reasoning: { effort: 'low' } });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agent.body.id}`)
        .send({ reasoning: { effort: 'max' } });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.body.id}`
      );
      expect(read.body.reasoning).toEqual({ effort: 'low' });
    });
  });
});
