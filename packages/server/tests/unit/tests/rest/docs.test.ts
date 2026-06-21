import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Docs', () => {
  let adminToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');
  });

  describe('GET /api/v1/docs', () => {
    test('returns list of doc pages for authenticated user', async () => {
      const res = await authenticatedTestClient(adminToken).get('/api/v1/docs');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      const page = res.body[0];
      expect(typeof page.path).toBe('string');
      expect(typeof page.title).toBe('string');
      expect(typeof page.description).toBe('string');
    });

    test('returns pages with correct titles parsed from markdown', async () => {
      const res = await authenticatedTestClient(adminToken).get('/api/v1/docs');
      expect(res.status).toBe(200);
      const agentsPage = res.body.find(
        (p: { path: string }) => p.path === 'modules/agents'
      );
      expect(agentsPage).toBeDefined();
      expect(agentsPage.title).toBe('Agents');
    });

    test('returns 401 for unauthenticated request', async () => {
      const res = await testClient.get('/api/v1/docs');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/docs/content', () => {
    test('returns content for a valid doc path', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/docs/content?path=introduction'
      );
      expect(res.status).toBe(200);
      expect(res.body.path).toBe('introduction');
      expect(res.body.title).toBe('Introduction');
      expect(typeof res.body.content).toBe('string');
      expect(res.body.content).toContain('# Introduction');
    });

    test('returns content for a nested doc path', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/docs/content?path=modules/agents'
      );
      expect(res.status).toBe(200);
      expect(res.body.path).toBe('modules/agents');
      expect(res.body.title).toBe('Agents');
    });

    test('returns 404 for unknown path', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/docs/content?path=nonexistent/page'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('returns 400 when path parameter is missing', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/docs/content'
      );
      expect(res.status).toBe(400);
    });

    test('returns 401 for unauthenticated request', async () => {
      const res = await testClient.get(
        '/api/v1/docs/content?path=introduction'
      );
      expect(res.status).toBe(401);
    });

    test('rejects path traversal attempts', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/docs/content?path=../../etc/passwd'
      );
      expect(res.status).toBe(404);
    });
  });
});
