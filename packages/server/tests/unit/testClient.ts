import { app } from 'src/app';
import request from 'supertest';

export const testClient = request(app.callback());

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
      return testClient.get(url).set('Authorization', Authorization);
    },
    post: (url: string) => {
      return testClient.post(url).set('Authorization', Authorization);
    },
    put: (url: string) => {
      return testClient.put(url).set('Authorization', Authorization);
    },
    patch: (url: string) => {
      return testClient.patch(url).set('Authorization', Authorization);
    },
    delete: (url: string) => {
      return testClient.delete(url).set('Authorization', Authorization);
    },
  };
};
