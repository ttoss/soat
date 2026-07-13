import { db } from 'src/db';
import { discussionsFormationModule } from 'src/lib/formation-modules/discussionsFormationModule';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('discussionsFormationModule', () => {
  let adminToken: string;
  let projectId: string;
  let projectDbId: number;
  let aiProviderId: string;
  let actorId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'discformadmin', password: 'supersecret' });
    adminToken = await loginAs('discformadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Discussion Formation Module Project' });
    projectId = projectRes.body.id;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectDbId = project?.id as number;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'DiscFormProvider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;

    const actorRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/actors')
      .send({ project_id: projectId, name: 'Formation Module Actor' });
    actorId = actorRes.body.id;
  });

  test('validateProperties rejects a non-object and a missing required field', () => {
    expect(
      discussionsFormationModule.validateProperties!({
        properties: 'nope',
        basePath: 'x',
      }).length
    ).toBeGreaterThan(0);
    expect(
      discussionsFormationModule.validateProperties!({
        properties: { name: 'x' },
        basePath: 'x',
      }).length
    ).toBeGreaterThan(0);
  });

  test('create resolves a fully-specified participant and synthesis, then read/update/delete', async () => {
    const created = await discussionsFormationModule.create!({
      projectId: projectDbId,
      properties: {
        name: 'Module panel',
        description: 'via module',
        ai_provider_id: aiProviderId,
        max_rounds: 2,
        synthesis: {
          ai_provider_id: aiProviderId,
          model: 'llama3.2',
          prompt: 'Weigh ${steps.deliberation}',
          effort: 'high',
        },
        participants: [
          {
            name: 'Full',
            prompt: 'persona',
            position: 0,
            actor_id: actorId,
            ai_provider_id: aiProviderId,
            model: 'llama3.2',
            temperature: 0.3,
            effort: 'low',
          },
        ],
      },
    });
    expect(created).toMatch(/^disc_/);

    const read = await discussionsFormationModule.read!({
      physicalResourceId: created,
    });
    expect(read?.name).toBe('Module panel');

    await discussionsFormationModule.update!({
      physicalResourceId: created,
      properties: {
        name: 'Module panel v2',
        ai_provider_id: aiProviderId,
        synthesis: null,
        participants: [{ name: 'Solo', prompt: 'alone' }],
      },
    });
    const readAfter = await discussionsFormationModule.read!({
      physicalResourceId: created,
    });
    expect(readAfter?.name).toBe('Module panel v2');

    await discussionsFormationModule.delete!({ physicalResourceId: created });
  });

  test('read returns null for a missing discussion (drift)', async () => {
    const read = await discussionsFormationModule.read!({
      physicalResourceId: 'disc_missing',
    });
    expect(read).toBeNull();
  });

  test('create throws on invalid properties', async () => {
    await expect(
      discussionsFormationModule.create!({
        projectId: projectDbId,
        properties: { name: 'no provider' },
      })
    ).rejects.toThrow();
  });
});
