import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  startStubChatProvider,
  type StubChatProvider,
  stubCompletion,
} from '../../fixtures/stubChatProvider';
import { authenticatedTestClient } from '../../testClient';

/**
 * A provider that reports no usage at all still meters the call, at zero on
 * every token count rather than null: the rollups sum these columns, and a null
 * would read as a call nobody measured. The breakdown a provider omits while
 * reporting totals is pinned in `rest/usage.test.ts`.
 */
describe('Usage — a provider that reports no usage', () => {
  let adminToken: string;
  let projectId: string;
  let agentId: string;
  let stub: StubChatProvider;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'usagenousage',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    stub = await startStubChatProvider({
      reply: () => {
        return stubCompletion({ usage: null });
      },
    });

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: setup.projectId,
        name: 'no-usage-provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stub.baseUrl,
      });
    expect(providerRes.status).toBe(201);
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: setup.projectId,
        ai_provider_id: providerRes.body.id,
        name: 'no-usage-agent',
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('GET /api/v1/generations/:generation_id', () => {
    test('reports every token count as zero', async () => {
      const genRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });
      expect(genRes.status).toBe(200);

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/generations/${genRes.body.id}`
      );

      expect(res.status).toBe(200);
      expect(res.body.usage).toEqual({
        cost_usd: null,
        input_tokens: 0,
        uncached_input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      });
    });
  });

  // The meter records the model the provider says it served; a provider that
  // names none leaves no name to price against, and the event says so.
  describe('a provider that names no model', () => {
    let namelessAgentId: string;
    let nameless: StubChatProvider;

    beforeAll(async () => {
      nameless = await startStubChatProvider({
        reply: () => {
          return stubCompletion({ model: '' });
        },
      });
      const providerRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'no-model-provider',
          provider: 'ollama',
          default_model: 'stub-model',
          base_url: nameless.baseUrl,
        });
      expect(providerRes.status).toBe(201);
      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: providerRes.body.id,
          name: 'no-model-agent',
        });
      expect(agentRes.status).toBe(201);
      namelessAgentId = agentRes.body.id;
    });

    afterAll(async () => {
      await nameless.close();
    });

    test('GET /api/v1/usage/events meters the call under `unknown`, unpriced', async () => {
      const genRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${namelessAgentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });
      expect(genRes.status).toBe(200);

      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/usage/events')
        .query({ generation_id: genRes.body.id, meter_type: 'llm_tokens' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        model: 'unknown',
        cost_usd: null,
      });
    });
  });
});
