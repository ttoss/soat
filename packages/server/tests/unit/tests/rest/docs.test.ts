import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const MOCK_LLMS_TXT = `# SOAT Documentation

## Modules

- [Agents](https://soat.ttoss.dev/docs/modules/agents): Core reasoning units
- [Actors](https://soat.ttoss.dev/docs/modules/actors): User-facing identities
`;

const MOCK_PAGE_CONTENT = `# Agents

Agents are the core reasoning units that run LLM inference loops.
`;

describe('Docs', () => {
  let adminToken: string;
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');
  });

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.endsWith('/llms.txt')) {
          return new Response(MOCK_LLMS_TXT, { status: 200 });
        }
        if (urlStr.includes('/docs/modules/agents')) {
          return new Response(MOCK_PAGE_CONTENT, { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('GET /api/v1/docs', () => {
    test('returns documentation index for authenticated user', async () => {
      const res = await authenticatedTestClient(adminToken).get('/api/v1/docs');
      expect(res.status).toBe(200);
      expect(typeof res.body.content).toBe('string');
      expect(res.body.content).toContain('SOAT Documentation');
    });

    test('returns 401 for unauthenticated request', async () => {
      const res = await testClient.get('/api/v1/docs');
      expect(res.status).toBe(401);
    });

    test('returns 404 when upstream is unavailable', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('error', { status: 503 }));
      const res = await authenticatedTestClient(adminToken).get('/api/v1/docs');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/docs/page', () => {
    test('returns page content for a valid docs URL', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/docs/page?url=https://soat.ttoss.dev/docs/modules/agents'
      );
      expect(res.status).toBe(200);
      expect(res.body.url).toBe(
        'https://soat.ttoss.dev/docs/modules/agents'
      );
      expect(res.body.content).toContain('Agents');
    });

    test('returns 404 for URL from a disallowed domain', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/docs/page?url=https://evil.com/secret'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('returns 404 for unknown page on the docs domain', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/docs/page?url=https://soat.ttoss.dev/docs/nonexistent'
      );
      expect(res.status).toBe(404);
    });

    test('returns 400 when url parameter is missing', async () => {
      const res =
        await authenticatedTestClient(adminToken).get('/api/v1/docs/page');
      expect(res.status).toBe(400);
    });

    test('returns 401 for unauthenticated request', async () => {
      const res = await testClient.get(
        '/api/v1/docs/page?url=https://soat.ttoss.dev/docs/modules/agents'
      );
      expect(res.status).toBe(401);
    });
  });
});
