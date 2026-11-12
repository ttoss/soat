import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A caller permitted in no project gets an empty answer from every list, never
 * a `403` (`iam.md` § What a Denial Looks Like).
 */
describe('a list for a caller permitted in no project', () => {
  let adminToken: string;
  let noProjectToken: string;
  let projectId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'emptyscopeadmin', password: 'supersecret' });
    adminToken = await loginAs('emptyscopeadmin', 'supersecret');

    const user = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'emptyscopeuser', password: 'nopassword' });
    expect(user.status).toBe(201);
    noProjectToken = await loginAs('emptyscopeuser', 'nopassword');

    const project = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Empty Scope Project' });
    projectId = project.body.id;
  });

  test.each([
    '/api/v1/sessions',
    '/api/v1/orchestration-runs',
    '/api/v1/generations',
    '/api/v1/usage/events',
    '/api/v1/usage/thresholds',
    '/api/v1/orchestrations/queue/stats/projects',
  ])('GET %s answers an empty page', async (path) => {
    const res = await authenticatedTestClient(noProjectToken).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], next_cursor: null });
  });

  test('GET /api/v1/orchestrations/queue/stats answers an empty snapshot', async () => {
    const res = await authenticatedTestClient(noProjectToken).get(
      '/api/v1/orchestrations/queue/stats'
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      queue_depth: 0,
      claimed_tasks: 0,
      oldest_queued_age_seconds: null,
      claim_latency_ms: { p50: null, p95: null },
    });
  });

  test('GET /api/v1/usage/receipt answers the not-found of an id naming nothing in scope', async () => {
    const res = await authenticatedTestClient(noProjectToken)
      .get('/api/v1/usage/receipt')
      .query({ generation_id: 'gen_nonexistent' });
    expect(res.status).toBe(404);
  });

  test('GET /api/v1/usage/aggregate naming a project the caller may not read is 403', async () => {
    const res = await authenticatedTestClient(noProjectToken)
      .get('/api/v1/usage/aggregate')
      .query({ project_id: projectId });
    expect(res.status).toBe(403);
  });
});
