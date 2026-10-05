import { runExtractionCompletion } from 'src/lib/memoryExtractionCompletion';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The two refusals `resolveCompletionModel` makes before any provider is
 * called. No entry point reaches either: a rule fires only for an agent that
 * exists in the store's project, and a rule's `ai_provider_id` is resolved in
 * that same project when the rule is written. Both stay as guards — one keeps a
 * completion config from borrowing another project's provider secret — and are
 * driven here directly. Everything an entry point reaches is in
 * `rest/memoryExtraction.test.ts`.
 */
describe('runExtractionCompletion', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'extractioncompladmin', password: 'supersecret' });
    adminToken = await loginAs('extractioncompladmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Extraction Completion Project' });
    projectId = projectRes.body.id;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'ExtractionCompletionProvider',
        provider: 'ollama',
        default_model: 'default-stub-model',
      });
    aiProviderId = aiProvRes.body.id;
  });

  test('refuses a provider override from another project', async () => {
    const otherProjectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Extraction Foreign Project' });
    const foreignProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: otherProjectRes.body.id,
        name: 'ForeignProvider',
        provider: 'ollama',
        default_model: 'foreign-model',
      });
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'ComplForeignProviderAgent',
      });

    await expect(
      runExtractionCompletion({
        agentId: agentRes.body.id,
        aiProviderId: foreignProvRes.body.id,
        prompt: 'Extract.',
      })
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_FOUND' });
  });

  test('refuses an agent that does not exist', async () => {
    await expect(
      runExtractionCompletion({
        agentId: 'agt_doesnotexist000',
        prompt: 'irrelevant',
      })
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
