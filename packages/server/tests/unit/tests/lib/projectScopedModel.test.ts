import { db } from 'src/db';
import { resolveProjectScopedModel } from 'src/lib/projectScopedModel';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Direct lib test: the resolver's branches (project-scoped provider, a provider
 * belonging to another project) are reached through REST only by running a full
 * eval with an `llm_judge` scorer, where the failure signal is a scored run
 * rather than the resolution error itself.
 */
describe('projectScopedModel lib', () => {
  let adminToken: string;
  let projectDbId: number;
  let aiProviderId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'psmadmin', password: 'supersecret' });
    adminToken = await loginAs('psmadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Project Scoped Model Project' });
    const project = await db.Project.findOne({
      where: { publicId: projectRes.body.id },
    });
    projectDbId = project?.id as number;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectRes.body.id,
        name: 'ProjectScopedProvider',
        provider: 'ollama',
        default_model: 'psm-default-model',
        base_url: 'http://127.0.0.1:1',
      });
    aiProviderId = aiProvRes.body.id;
  });

  test('resolves a project-scoped provider and its attribution', async () => {
    const resolved = await resolveProjectScopedModel({
      projectId: projectDbId,
      aiProviderId,
    });
    expect(resolved.modelName).toBe('psm-default-model');
    expect(resolved.attribution?.provider).toBe('ollama');
    expect(resolved.attribution?.modelName).toBe('psm-default-model');
  });

  test('a pinned model overrides the provider default', async () => {
    const resolved = await resolveProjectScopedModel({
      projectId: projectDbId,
      aiProviderId,
      model: 'psm-pinned-model',
    });
    expect(resolved.modelName).toBe('psm-pinned-model');
    expect(resolved.attribution?.modelName).toBe('psm-pinned-model');
  });

  test('throws for a provider not in the project', async () => {
    await expect(
      resolveProjectScopedModel({
        projectId: projectDbId,
        aiProviderId: 'aip_x',
      })
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_FOUND' });
  });
});
