import { app } from 'src/app';
import type { Test } from 'supertest';
import request from 'supertest';

import { assertResponseMatchesSpec } from './openapiContract';

const agent = request(app.callback());

/**
 * Attaches an OpenAPI contract assertion to every request so that when the
 * response resolves it is validated against the spec schema for its
 * `(path, method, status)`. `.expect(fn)` runs the checker inside supertest's
 * completion flow — a throw rejects the awaited promise and fails the test.
 */
const withContract = (test: Test, method: string, url: string): Test => {
  return test.expect((res) => {
    const contentType = res.headers?.['content-type'];
    assertResponseMatchesSpec({
      method,
      path: url,
      status: res.status,
      body: res.body,
      contentType: typeof contentType === 'string' ? contentType : undefined,
    });
  });
};

/**
 * Unauthenticated supertest client. Every response is contract-validated
 * against the OpenAPI spec (see {@link withContract}).
 */
export const testClient = {
  get: (url: string) => {
    return withContract(agent.get(url), 'get', url);
  },
  post: (url: string) => {
    return withContract(agent.post(url), 'post', url);
  },
  put: (url: string) => {
    return withContract(agent.put(url), 'put', url);
  },
  patch: (url: string) => {
    return withContract(agent.patch(url), 'patch', url);
  },
  delete: (url: string) => {
    return withContract(agent.delete(url), 'delete', url);
  },
};

/**
 * Logs in with the given credentials and returns a Bearer token.
 * Drives the implementation of POST /api/v1/users/login.
 */
export const loginAs = async (
  username: string,
  password: string
): Promise<string> => {
  const res = await testClient
    .post('/api/v1/users/login')
    .send({ username, password });
  return res.body.token as string;
};

/**
 * Helper to create authenticated requests with proper Origin header
 * Use this for requests that require JWT authentication
 */
export const authenticatedTestClient = (token: string) => {
  const Authorization = `Bearer ${token}`;

  return {
    get: (url: string) => {
      return withContract(
        agent.get(url).set('Authorization', Authorization),
        'get',
        url
      );
    },
    post: (url: string) => {
      return withContract(
        agent.post(url).set('Authorization', Authorization),
        'post',
        url
      );
    },
    put: (url: string) => {
      return withContract(
        agent.put(url).set('Authorization', Authorization),
        'put',
        url
      );
    },
    patch: (url: string) => {
      return withContract(
        agent.patch(url).set('Authorization', Authorization),
        'patch',
        url
      );
    },
    delete: (url: string) => {
      return withContract(
        agent.delete(url).set('Authorization', Authorization),
        'delete',
        url
      );
    },
  };
};
