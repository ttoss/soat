import { db } from 'src/db';
import { resolveAgentModel } from 'src/lib/agentModelResolution';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';
import { resolveChatModel } from 'src/lib/chatCompletionModel';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A provider record is the credential an agent, chat or route generates with,
 * so resolving one is scoped to the project doing the resolving. The write
 * paths refuse a cross-project pin, and this is the half underneath them: a row
 * that holds such a pin anyway — written before the rule, or by a path that
 * forgot it — resolves to nothing rather than to another project's secret.
 */
describe('resolving a provider is scoped to the consuming project', () => {
  let adminToken: string;
  let projectDbId: number;
  let otherProjectDbId: number;
  let aiProviderId: string;
  let otherAiProviderId: string;
  let agentId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'aipsadmin', password: 'supersecret' });
    adminToken = await loginAs('aipsadmin', 'supersecret');

    const project = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Provider Scope Project' });
    const other = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Provider Scope Other Project' });

    projectDbId = (
      await db.Project.findOne({
        where: { publicId: project.body.id },
      })
    )?.id as number;
    otherProjectDbId = (
      await db.Project.findOne({
        where: { publicId: other.body.id },
      })
    )?.id as number;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: project.body.id,
        name: 'Scope Provider',
        provider: 'ollama',
        default_model: 'scope-model',
        base_url: 'http://127.0.0.1:1',
      });
    aiProviderId = provider.body.id;

    const otherProvider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: other.body.id,
        name: 'Scope Other Provider',
        provider: 'ollama',
        default_model: 'other-scope-model',
        base_url: 'http://127.0.0.1:1',
      });
    otherAiProviderId = otherProvider.body.id;

    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({ project_id: project.body.id, ai_provider_id: aiProviderId });
    agentId = agent.body.id;
  });

  test('resolves a provider in its own project', async () => {
    const resolved = await resolveAiProviderSecret({
      aiProviderId,
      projectId: projectDbId,
    });
    expect(resolved?.defaultModel).toBe('scope-model');
  });

  test('does not resolve a provider belonging to another project', async () => {
    const resolved = await resolveAiProviderSecret({
      aiProviderId: otherAiProviderId,
      projectId: projectDbId,
    });
    expect(resolved).toBeNull();
  });

  test('resolves the same provider from the project that owns it', async () => {
    const resolved = await resolveAiProviderSecret({
      aiProviderId: otherAiProviderId,
      projectId: otherProjectDbId,
    });
    expect(resolved?.defaultModel).toBe('other-scope-model');
  });

  // A stateless completion belongs to no project of its own, so the provider
  // names the project rather than the other way round — the one shape where the
  // scope is the provider's own, and it still goes through the scoped resolver
  // with that project.
  test("a stateless completion resolves through the provider's own project", async () => {
    const resolved = await resolveChatModel({
      aiProviderId: otherAiProviderId,
    });
    expect(resolved.modelName).toBe('other-scope-model');
  });

  // The route this serves maps this exact message to its published 404, so the
  // string is contract rather than prose.
  test('a stateless completion naming no real provider reports it', async () => {
    await expect(
      resolveChatModel({ aiProviderId: 'aip_doesnotexist000000' })
    ).rejects.toThrow('AI provider not found');
  });

  // The stored pin is repointed underneath the write guards, which is the
  // state a row written before them is in.
  test('an agent holding a cross-project pin resolves no model', async () => {
    const otherProvider = await db.AiProvider.findOne({
      where: { publicId: otherAiProviderId },
    });
    await db.Agent.update(
      { aiProviderId: otherProvider?.id },
      { where: { publicId: agentId } }
    );

    const agent = await db.Agent.findOne({
      where: { publicId: agentId },
      include: [
        { model: db.Project, as: 'project' },
        { model: db.AiProvider, as: 'aiProvider' },
        { model: db.ModelRoute, as: 'modelRoute' },
      ],
    });

    const resolution = await resolveAgentModel(agent as never);
    expect(resolution.failure).toBe('provider_unresolvable');
  });
});
