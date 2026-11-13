import http from 'node:http';

import { app } from 'src/app';
import { dispatchApiRequest } from 'src/lib/inProcessApi';
import type { WorkAuthority } from 'src/lib/workAuthority';
import type { Test } from 'supertest';
import request from 'supertest';

import { assertResponseMatchesSpec } from './openapiContract';

// A listening server the tests own: supertest closes a server it starts itself
// as soon as any request on it settles, which breaks a request built before an
// `await` and sent after another one completes. Without a host, `listen`
// binds synchronously, so `address()` is available to the first request.
const server = http.createServer(app.callback());
server.listen(0);
server.unref();

const agent = request(server);

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

/**
 * A request stored work makes in-process, under `authority`: the one way a
 * test acts as an orchestration run's, a task's or a firing's own call.
 */
export const workRequest = (args: {
  authority: WorkAuthority;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: unknown;
  // Read like a supertest response body.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<{ status: number; body: any }> => {
  return dispatchApiRequest({
    method: args.method,
    path: args.path,
    body: args.body,
    authority: args.authority,
  });
};

/** A stored authority, as work a user's or a key's request started holds it. */
export const workAuthorityOf = (args: {
  project: string | null;
  user: string;
  key?: string;
  work?: string;
  trigger?: string;
}): WorkAuthority => {
  return {
    project: args.project,
    grant: { holder: 'user', user: args.user },
    caps: args.key ? [{ kind: 'key', key: args.key }] : [],
    principal: args.key
      ? { type: 'api_key', id: args.key }
      : { type: 'user', id: args.user },
    trigger: args.trigger ?? null,
    work: args.work ?? null,
    actsFor: null,
  };
};

type WorkMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A request {@link workClient} builds: `.send` a body, then await it. */
type WorkRequestBuilder = PromiseLike<
  Awaited<ReturnType<typeof workRequest>>
> & {
  send: (body: unknown) => WorkRequestBuilder;
};

/**
 * {@link authenticatedTestClient}'s shape for stored work: each request runs
 * in-process under `authority`.
 */
export const workClient = (authority: WorkAuthority) => {
  const build = (method: WorkMethod, path: string, body?: unknown) => {
    const builder: WorkRequestBuilder = {
      send: (next) => {
        return build(method, path, next);
      },
      then: (onFulfilled, onRejected) => {
        return workRequest({ authority, method, path, body }).then(
          onFulfilled,
          onRejected
        );
      },
    };
    return builder;
  };
  return {
    get: (path: string) => {
      return build('get', path);
    },
    post: (path: string) => {
      return build('post', path);
    },
    put: (path: string) => {
      return build('put', path);
    },
    patch: (path: string) => {
      return build('patch', path);
    },
    delete: (path: string) => {
      return build('delete', path);
    },
  };
};

/** A bearer token, or the stored authority of work making the request. */
export type TestCredential = string | WorkAuthority;

/** The client for either kind of {@link TestCredential}. */
export const clientFor = (credential: TestCredential) => {
  return typeof credential === 'string'
    ? authenticatedTestClient(credential)
    : workClient(credential);
};

/** The stored authority of work the holder of `token` started in `project`. */
export const workAuthorityOfToken = async (args: {
  token: string;
  project: string | null;
}): Promise<WorkAuthority> => {
  const me = await authenticatedTestClient(args.token).get('/api/v1/users/me');
  return workAuthorityOf({ project: args.project, user: me.body.id });
};
