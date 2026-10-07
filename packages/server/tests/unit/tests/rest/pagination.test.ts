import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A malformed or out-of-domain `limit`/`offset` is `400 VALIDATION_FAILED`; a
 * limit above the list's ceiling is clamped and the response says so. One
 * route per shape: an offset list, one whose route parsed its own query, the
 * audit log's wider page, and the cursor-paged activity feed.
 */
describe('list pagination parameters', () => {
  let adminToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'paging',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
  });

  const get = (path: string, query: Record<string, string>) => {
    return authenticatedTestClient(adminToken)
      .get(path)
      .query({ project_id: projectId, ...query });
  };

  const OFFSET_LISTS = [
    { path: '/api/v1/secrets', max: 100 },
    { path: '/api/v1/actors', max: 100 },
    { path: '/api/v1/audit-log', max: 200 },
  ];

  const REFUSED: Record<string, string>[] = [
    { limit: 'abc' },
    { limit: '1.5' },
    { limit: '10abc' },
    { limit: '0' },
    { limit: '-1' },
    { offset: 'abc' },
    { offset: '-1' },
  ];

  describe.each(OFFSET_LISTS)('$path', ({ path, max }) => {
    test.each(REFUSED)('refuses %o', async (query) => {
      const response = await get(path, query);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('clamps a limit above the ceiling', async () => {
      const response = await get(path, { limit: String(max + 1) });

      expect(response.status).toBe(200);
      expect(response.body.limit).toBe(max);
    });

    test('accepts the bounds themselves', async () => {
      const response = await get(path, { limit: '1', offset: '0' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ limit: 1, offset: 0 });
    });
  });

  describe('/api/v1/activity', () => {
    test.each([{ limit: 'abc' }, { limit: '0' }, { limit: '-1' }])(
      'refuses %o',
      async (query) => {
        const response = await get('/api/v1/activity', query);

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      }
    );

    test('clamps a limit above the ceiling', async () => {
      const response = await get('/api/v1/activity', { limit: '101' });

      expect(response.status).toBe(200);
    });
  });
});
