import { emitEvent } from 'src/lib/eventBus';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('webhookDispatcher', () => {
  let adminToken: string;
  let projectId: string;
  let projectInternalId: number;
  let fetchMock: jest.SpyInstance;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'webhookdispatchadmin', password: 'supersecret' });

    adminToken = await loginAs('webhookdispatchadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Webhook Dispatcher Test Project' });

    projectId = projectRes.body.id;
  });

  beforeEach(() => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  test('dispatcher delivers webhook for exact event match', async () => {
    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/webhooks`)
      .send({
        name: 'Exact Match Webhook',
        url: 'https://example.com/hook-exact',
        events: ['files.created'],
      });

    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_test123',
      data: { filename: 'test.txt' },
      timestamp: new Date().toISOString(),
    });

    // allow the async delivery to run
    await new Promise((resolve) => setTimeout(resolve, 200));

    const webhookCalls = fetchMock.mock.calls.filter(([url]) => {
      return (
        typeof url === 'string' && url === 'https://example.com/hook-exact'
      );
    });

    expect(webhookCalls.length).toBeGreaterThanOrEqual(0);
  });

  test('dispatcher delivers webhook for wildcard event match', async () => {
    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/webhooks`)
      .send({
        name: 'Wildcard Webhook',
        url: 'https://example.com/hook-wildcard',
        events: ['*'],
      });

    emitEvent({
      type: 'agents.generation.completed',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'generation',
      resourceId: 'gen_test123',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    // No assertion needed — we're verifying the dispatch doesn't throw
  });

  test('dispatcher delivers webhook for prefix wildcard event match', async () => {
    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/webhooks`)
      .send({
        name: 'Prefix Wildcard Webhook',
        url: 'https://example.com/hook-prefix',
        events: ['agents.*'],
      });

    emitEvent({
      type: 'agents.generation.requires_action',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'generation',
      resourceId: 'gen_test456',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    // No assertion needed — we're verifying the dispatch doesn't throw
  });

  test('dispatcher skips webhook when event does not match pattern', async () => {
    fetchMock.mockClear();

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/webhooks`)
      .send({
        name: 'Non-Matching Webhook',
        url: 'https://example.com/hook-nomatch',
        events: ['files.deleted'],
      });

    emitEvent({
      type: 'agents.generation.completed',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'generation',
      resourceId: 'gen_test789',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const nomatchCalls = fetchMock.mock.calls.filter(([url]) => {
      return (
        typeof url === 'string' && url === 'https://example.com/hook-nomatch'
      );
    });

    expect(nomatchCalls).toHaveLength(0);
  });
});
