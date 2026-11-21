import {
  disableFormationResourceTypes,
  enableFormationResourceTypes,
} from 'src/lib/formationsRegistry';

import {
  type FormationModuleFixtures,
  setupFormationModuleFixtures,
  templateOf,
} from '../../fixtures/formationModules';
import { authenticatedTestClient } from '../../testClient';

// A deployment disables a built-in type: every template declaring it is
// refused for every principal, while a formation already holding one still
// tears down.

let fx: FormationModuleFixtures;

const chatTemplate = () => {
  return templateOf('chat', {
    ai_provider_id: fx.aiProviderId,
    name: 'Disabled chat',
    model: 'gpt-4o',
  });
};

const client = () => {
  return authenticatedTestClient(fx.adminToken);
};

const expectRefusal = (errors: { path: string; message: string }[]) => {
  expect(errors).toEqual([
    expect.objectContaining({
      path: 'resources.Res.type',
      message: expect.stringContaining('Unsupported resource type: chat.'),
    }),
  ]);
  const listed = errors[0].message.split('Supported: ')[1].split(', ');
  expect(listed).not.toContain('chat');
  expect(listed).toContain('agent');
};

beforeAll(async () => {
  fx = await setupFormationModuleFixtures({ prefix: 'fmdisabled' });
});

afterEach(() => {
  enableFormationResourceTypes({ names: ['chat'] });
});

describe('a deployment-disabled resource type', () => {
  test('validate answers valid: false, naming only the served types', async () => {
    disableFormationResourceTypes({ names: ['chat'] });

    const res = await client()
      .post('/api/v1/formations/validate')
      .send({ template: chatTemplate() });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expectRefusal(res.body.errors);
  });

  test('plan refuses it with VALIDATION_FAILED', async () => {
    disableFormationResourceTypes({ names: ['chat'] });

    const res = await client()
      .post('/api/v1/formations/plan')
      .send({ project_id: fx.projectId, template: chatTemplate() });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expectRefusal(res.body.error.meta.details);
  });

  test('deploy refuses it with VALIDATION_FAILED', async () => {
    disableFormationResourceTypes({ names: ['chat'] });

    const res = await client().post('/api/v1/formations').send({
      project_id: fx.projectId,
      name: 'disabled-deploy',
      template: chatTemplate(),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expectRefusal(res.body.error.meta.details);
  });

  test('a formation created before the type was disabled deletes cleanly', async () => {
    const created = await client().post('/api/v1/formations').send({
      project_id: fx.projectId,
      name: 'disabled-later',
      template: chatTemplate(),
    });
    expect(created.status).toBe(201);
    const chatId: string = created.body.resources[0].physical_resource_id;

    disableFormationResourceTypes({ names: ['chat'] });

    const updated = await client()
      .put(`/api/v1/formations/${created.body.id}`)
      .send({ template: chatTemplate() });
    expect(updated.status).toBe(400);
    expect(updated.body.error.code).toBe('VALIDATION_FAILED');

    const deleted = await client().delete(
      `/api/v1/formations/${created.body.id}`
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);

    const chat = await client().get(`/api/v1/chats/${chatId}`);
    expect(chat.status).toBe(404);
  });
});
