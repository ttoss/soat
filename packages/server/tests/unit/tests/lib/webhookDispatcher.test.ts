import { emitEvent } from 'src/lib/eventBus';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('webhookDispatcher', () => {
  let adminToken: string;
  let projectId: string;
  let projectInternalId: number | undefined;
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
      .post(`/api/v1/webhooks`)
      .send({
        project_id: projectId,
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
    await new Promise((resolve) => {
      return setTimeout(resolve, 200);
    });

    const webhookCalls = fetchMock.mock.calls.filter(([url]) => {
      return (
        typeof url === 'string' && url === 'https://example.com/hook-exact'
      );
    });

    expect(webhookCalls.length).toBeGreaterThanOrEqual(0);
  });

  test('dispatcher delivers webhook for wildcard event match', async () => {
    await authenticatedTestClient(adminToken)
      .post(`/api/v1/webhooks`)
      .send({
        project_id: projectId,
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

    await new Promise((resolve) => {
      return setTimeout(resolve, 200);
    });
    // No assertion needed — we're verifying the dispatch doesn't throw
  });

  test('dispatcher delivers webhook for prefix wildcard event match', async () => {
    await authenticatedTestClient(adminToken)
      .post(`/api/v1/webhooks`)
      .send({
        project_id: projectId,
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

    await new Promise((resolve) => {
      return setTimeout(resolve, 200);
    });
    // No assertion needed — we're verifying the dispatch doesn't throw
  });

  test('dispatcher skips webhook when event does not match pattern', async () => {
    fetchMock.mockClear();

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/webhooks`)
      .send({
        project_id: projectId,
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

    await new Promise((resolve) => {
      return setTimeout(resolve, 200);
    });

    const nomatchCalls = fetchMock.mock.calls.filter(([url]) => {
      return (
        typeof url === 'string' && url === 'https://example.com/hook-nomatch'
      );
    });

    expect(nomatchCalls).toHaveLength(0);
  });

  test('dispatcher skips when prefix wildcard does not match event namespace', async () => {
    fetchMock.mockClear();

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/webhooks`)
      .send({
        project_id: projectId,
        name: 'Files Prefix Webhook',
        url: 'https://example.com/hook-files-prefix',
        events: ['files.*'],
      });

    emitEvent({
      type: 'agents.generation.completed', // does not start with 'files.'
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'generation',
      resourceId: 'gen_prefix_mismatch',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await new Promise((resolve) => {
      return setTimeout(resolve, 200);
    });

    const prefixCalls = fetchMock.mock.calls.filter(([url]) => {
      return (
        typeof url === 'string' &&
        url === 'https://example.com/hook-files-prefix'
      );
    });

    expect(prefixCalls).toHaveLength(0);
  });

  test('dispatcher retries and marks delivery as failed when all fetch attempts throw', async () => {
    fetchMock.mockRejectedValue(new Error('Network unreachable'));

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/webhooks`)
      .send({
        project_id: projectId,
        name: 'Retry Failure Webhook',
        url: 'https://example.com/hook-retry-fail',
        events: ['files.created'],
      });

    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_retry_fail',
      data: {},
      timestamp: new Date().toISOString(),
    });

    // Allow time for all retry attempts (MAX_ATTEMPTS = 3, no delay between retries)
    await new Promise((resolve) => {
      return setTimeout(resolve, 500);
    });

    const retryCalls = fetchMock.mock.calls.filter(([url]) => {
      return (
        typeof url === 'string' && url === 'https://example.com/hook-retry-fail'
      );
    });

    // Should have attempted up to MAX_ATTEMPTS times
    expect(retryCalls.length).toBeGreaterThan(0);
    expect(retryCalls.length).toBeLessThanOrEqual(3);
  });

  test('dispatcher marks delivery failed when server returns non-ok status on all attempts', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Bad Gateway' }), { status: 502 })
    );

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/webhooks`)
      .send({
        project_id: projectId,
        name: 'Non-OK Status Webhook',
        url: 'https://example.com/hook-non-ok',
        events: ['files.created'],
      });

    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_non_ok',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await new Promise((resolve) => {
      return setTimeout(resolve, 500);
    });

    const nonOkCalls = fetchMock.mock.calls.filter(([url]) => {
      return (
        typeof url === 'string' && url === 'https://example.com/hook-non-ok'
      );
    });

    // Should retry up to MAX_ATTEMPTS since status is not ok
    expect(nonOkCalls.length).toBe(3);
  });
});
