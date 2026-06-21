import { http, HttpResponse } from 'msw';

import { testSpec } from '../fixtures/spec';

export const TEST_USER = {
  id: 'usr_test',
  username: 'tester',
  role: 'admin' as const,
};

/**
 * Default handlers shared by every test. Individual tests override specific
 * routes with `server.use(...)`. URLs are matched with a `*` host wildcard
 * because in jsdom relative requests resolve against `http://localhost/`.
 */
export const defaultHandlers = [
  http.get('*/api/v1/users/me', () => {
    return HttpResponse.json(TEST_USER);
  }),
  http.post('*/api/v1/users/login', async ({ request }) => {
    const body = (await request.json()) as {
      username: string;
      password: string;
    };
    if (body.password === 'wrong') {
      return HttpResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }
    return HttpResponse.json({ ...TEST_USER, token: 'test-token' });
  }),
  http.get('*/api/v1/openapi.json', () => {
    return HttpResponse.json(testSpec);
  }),
  http.get('*/api/v1/projects', () => {
    return HttpResponse.json([]);
  }),
  http.get('*/api/v1/users', () => {
    return HttpResponse.json([]);
  }),
  http.get('*/api/v1/policies', () => {
    return HttpResponse.json([]);
  }),
  http.get('*/api/v1/ai-providers', () => {
    return HttpResponse.json([]);
  }),
  http.get('*/api/v1/projects/:project_id/api-keys', () => {
    return HttpResponse.json([]);
  }),
];
