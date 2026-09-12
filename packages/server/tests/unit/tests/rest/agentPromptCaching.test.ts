import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Prompt caching, end to end: what the agent stores, and what actually reaches
 * the provider.
 *
 * The wire assertion runs against a stub Anthropic endpoint rather than a mock
 * of the generation path, because the failure this feature exists to prevent is
 * invisible from every layer above it — an agent whose config reads
 * `"enabled": true` and whose requests carry no `cache_control` looks correct
 * on every read surface and is only distinguishable on the bill.
 */
describe('Agent prompt caching', () => {
  let stubServer: Server;
  let requestBodies: Array<Record<string, unknown>>;
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;

  const anthropicResponse = {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: 'all set' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 4,
      output_tokens: 2,
      cache_creation_input_tokens: 11,
      cache_read_input_tokens: 0,
    },
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

  const createAgent = async (body: Record<string, unknown>) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProviderId,
        project_id: projectId,
        model: 'claude-haiku-4-5',
        ...body,
      });
  };

  const generate = async (agentId: string) => {
    return authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hi' }] });
  };

  /**
   * The metered component quantities for one generation, keyed by component.
   *
   * Polled rather than read once: the usage event is written after the response
   * is delivered, so the read is racing the write the turn set going.
   */
  const readEventQuantities = async (
    generationId: string
  ): Promise<Record<string, number>> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const events = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/events?generation_id=${generationId}`
      );
      expect(events.status).toBe(200);
      const event = events.body.data[0];
      if (event) {
        return Object.fromEntries(
          event.components.map(
            (component: { component: string; quantity: number }) => {
              return [component.component, component.quantity];
            }
          )
        );
      }
    }
    throw new Error(`no usage event recorded for ${generationId}`);
  };

  /** The `system` blocks of the most recent request the stub received. */
  const lastSystemBlocks = (): Array<Record<string, unknown>> => {
    const body = requestBodies.at(-1);
    return Array.isArray(body?.system)
      ? (body.system as Array<Record<string, unknown>>)
      : [];
  };

  beforeAll(async () => {
    requestBodies = [];
    const stubBaseUrl = await startStubServer();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'promptcacheadmin', password: 'supersecret' });
    const adminToken = await loginAs('promptcacheadmin', 'supersecret');

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'promptcacheuser', password: 'promptcachepass' });
    userToken = await loginAs('promptcacheuser', 'promptcachepass');

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'agents:CreateAgent',
                'agents:UpdateAgent',
                'agents:GetAgent',
                'agents:CreateAgentGeneration',
                'secrets:CreateSecret',
                'usage:ListEvents',
              ],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Prompt Caching Project' });
    projectId = projectRes.body.id;

    const secretRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({
        project_id: projectId,
        name: 'Prompt Caching Key',
        value: 'sk-ant-stub',
      });

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Stub Anthropic',
        provider: 'anthropic',
        default_model: 'claude-haiku-4-5',
        secret_id: secretRes.body.id,
        base_url: stubBaseUrl,
      });
    aiProviderId = aiProviderRes.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        return resolve();
      });
    });
  });

  describe('POST /api/v1/agents', () => {
    test('stores and echoes the config', async () => {
      const response = await createAgent({
        name: 'Caching Agent',
        instructions: 'Be terse.',
        prompt_caching: { enabled: true },
      });

      expect(response.status).toBe(201);
      expect(response.body.prompt_caching).toEqual({ enabled: true });
    });

    test('an agent that asks for nothing reads as null', async () => {
      const response = await createAgent({ name: 'Plain Agent' });

      expect(response.status).toBe(201);
      expect(response.body.prompt_caching).toBeNull();
    });

    test('a misspelled key is refused rather than stored inert', async () => {
      const response = await createAgent({
        name: 'Typo Agent',
        prompt_caching: { enable: true },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a non-boolean `enabled` is refused', async () => {
      const response = await createAgent({
        name: 'Bad Enabled Agent',
        prompt_caching: { enabled: 'yes' },
      });

      expect(response.status).toBe(400);
    });

    test('returns 401 when unauthenticated', async () => {
      const response = await testClient
        .post('/api/v1/agents')
        .send({ project_id: projectId, prompt_caching: { enabled: true } });

      expect(response.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/agents/:agent_id', () => {
    test('turns caching on and back off', async () => {
      const created = await createAgent({
        name: 'Toggled Agent',
        instructions: 'Be terse.',
      });

      const on = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ prompt_caching: { enabled: true } });
      expect(on.status).toBe(200);
      expect(on.body.prompt_caching).toEqual({ enabled: true });

      const off = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ prompt_caching: null });
      expect(off.status).toBe(200);
      expect(off.body.prompt_caching).toBeNull();
    });
  });

  describe('the outgoing request', () => {
    test('marks the system block when the agent enables caching', async () => {
      const created = await createAgent({
        name: 'Wire Caching Agent',
        instructions: 'Be terse.',
        prompt_caching: { enabled: true },
      });

      const response = await generate(created.body.id);
      expect(response.status).toBe(200);

      expect(lastSystemBlocks()).toEqual([
        {
          type: 'text',
          text: 'Be terse.',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    test('leaves the system block unmarked when the agent does not', async () => {
      const created = await createAgent({
        name: 'Wire Plain Agent',
        instructions: 'Be terse.',
      });

      const response = await generate(created.body.id);
      expect(response.status).toBe(200);

      expect(lastSystemBlocks()).toEqual([{ type: 'text', text: 'Be terse.' }]);
    });

    // The mark has to be the *last* thing before the conversation, or the tool
    // definitions and instructions it is meant to cover fall outside the cached
    // prefix. Nothing after it may carry one.
    test('marks nothing in the conversation itself', async () => {
      const created = await createAgent({
        name: 'Wire Message Agent',
        instructions: 'Be terse.',
        prompt_caching: { enabled: true },
      });

      await generate(created.body.id);

      expect(JSON.stringify(requestBodies.at(-1)?.messages)).not.toContain(
        'cache_control'
      );
    });
  });

  describe('what the write is metered as', () => {
    // The provider reports the cache write inside its one input figure, and a
    // write costs more than an uncached token — so a write folded into
    // `input_tokens` is billed at a rate nobody charges. This is the assertion
    // that keeps the three input dimensions disjoint and separately priceable.
    test('a cache write is its own component, disjoint from input_tokens', async () => {
      const created = await createAgent({
        name: 'Metered Caching Agent',
        instructions: 'Be terse.',
        prompt_caching: { enabled: true },
      });

      const generation = await generate(created.body.id);
      expect(generation.status).toBe(200);

      const quantities = await readEventQuantities(generation.body.id);

      expect(quantities.cache_write_tokens).toBe(
        anthropicResponse.usage.cache_creation_input_tokens
      );
      expect(quantities.input_tokens).toBe(
        anthropicResponse.usage.input_tokens
      );
      expect(quantities.cached_tokens).toBeUndefined();
    });
  });
});
