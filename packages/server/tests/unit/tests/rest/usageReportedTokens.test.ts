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
  let agentId: string;
  let stub: StubChatProvider;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'usagenousage',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
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
});
