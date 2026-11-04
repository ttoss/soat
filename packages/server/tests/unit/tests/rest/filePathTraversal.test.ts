import fs from 'node:fs';

import type { Response } from 'supertest';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A `..` segment in a `prefix` or a `filename` is refused on every route that
 * files something by them, whether or not it would climb above `/`. A `..`
 * inside a name is a plain name, and a filename may nest.
 */
describe('a `..` segment in a file key', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'file-traversal',
      policyActions: ['files:*', 'documents:*'],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
  }, 60_000);

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const client = (token?: string) => {
    return token ? authenticatedTestClient(token) : testClient;
  };

  const unique = () => {
    seq += 1;
    return `/traversal-${seq}`;
  };

  type Key = { prefix: string; filename: string };

  const createFile = async (): Promise<string> => {
    const res = await client(userToken)
      .post('/api/v1/files/upload/base64')
      .send({
        project_id: projectId,
        prefix: unique(),
        filename: 'held.txt',
        content_type: 'text/plain',
        content: Buffer.from('Held.').toString('base64'),
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createDocument = async (): Promise<string> => {
    const res = await client(userToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: 'Held.',
        path: `${unique()}/held.txt`,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  type Route = {
    name: string;
    /** What a caller without the action gets: `404` on a by-id write. */
    refusal: 401 | 403 | 404;
    /** Whether the route takes a filename it files under. */
    takesFilename: boolean;
    call: (args: { token?: string; key: Key }) => Promise<Response>;
    /** The stored key, when the answer carries one. */
    pathOf?: (res: Response) => string;
  };

  const filePath = (res: Response) => {
    return res.body.path as string;
  };

  const routes: Route[] = [
    {
      name: 'POST /files/upload',
      refusal: 403,
      takesFilename: true,
      call: ({ token, key }) => {
        return client(token)
          .post('/api/v1/files/upload')
          .attach('file', Buffer.from('bytes'), { filename: 'x.txt' })
          .field('project_id', projectId)
          .field('prefix', key.prefix)
          .field('filename', key.filename);
      },
      pathOf: filePath,
    },
    {
      name: 'POST /files/upload/base64',
      refusal: 403,
      takesFilename: true,
      call: ({ token, key }) => {
        return client(token)
          .post('/api/v1/files/upload/base64')
          .send({
            project_id: projectId,
            content: Buffer.from('bytes').toString('base64'),
            ...key,
          });
      },
      pathOf: filePath,
    },
    {
      name: 'POST /files',
      refusal: 403,
      takesFilename: true,
      call: ({ token, key }) => {
        return client(token)
          .post('/api/v1/files')
          .send({ project_id: projectId, ...key });
      },
      pathOf: filePath,
    },
    {
      name: 'POST /files/presigned-url',
      refusal: 403,
      takesFilename: true,
      call: ({ token, key }) => {
        return client(token)
          .post('/api/v1/files/presigned-url')
          .send({ project_id: projectId, ...key });
      },
    },
    {
      name: 'PATCH /files/{file_id}/metadata',
      refusal: 404,
      takesFilename: true,
      call: async ({ token, key }) => {
        const id = await createFile();
        return client(token).patch(`/api/v1/files/${id}/metadata`).send(key);
      },
      pathOf: filePath,
    },
    {
      name: 'POST /documents',
      refusal: 403,
      takesFilename: true,
      call: ({ token, key }) => {
        return client(token)
          .post('/api/v1/documents')
          .send({
            project_id: projectId,
            content: 'Filed.',
            path: `${key.prefix}/${key.filename}`,
          });
      },
      pathOf: filePath,
    },
    {
      name: 'POST /documents with a filename only',
      refusal: 403,
      takesFilename: true,
      call: ({ token, key }) => {
        return client(token)
          .post('/api/v1/documents')
          .send({
            project_id: projectId,
            content: 'Filed.',
            filename: `${key.prefix}/${key.filename}`,
          });
      },
      pathOf: filePath,
    },
    {
      name: 'PATCH /documents/{document_id}',
      refusal: 404,
      takesFilename: true,
      call: async ({ token, key }) => {
        const id = await createDocument();
        return client(token)
          .patch(`/api/v1/documents/${id}`)
          .send({ path: `${key.prefix}/${key.filename}` });
      },
      pathOf: filePath,
    },
    {
      name: 'POST /documents/ingest',
      refusal: 403,
      takesFilename: false,
      call: async ({ token, key }) => {
        const id = await createFile();
        return client(token).post('/api/v1/documents/ingest').send({
          project_id: projectId,
          file_id: id,
          path_prefix: key.prefix,
        });
      },
    },
  ];

  describe.each(routes)('$name', (route) => {
    test('a nested filename with `..` inside a name is filed', async () => {
      const prefix = unique();
      const res = await route.call({
        token: userToken,
        key: { prefix, filename: 'a/b..c.txt' },
      });

      expect([201, 202, 200]).toContain(res.status);
      if (route.pathOf) {
        expect(route.pathOf(res)).toBe(`${prefix}/a/b..c.txt`);
      }
    });

    test('a `..` segment in the prefix answers 400', async () => {
      const res = await route.call({
        token: userToken,
        key: { prefix: `${unique()}/inner/..`, filename: 'x.txt' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    if (route.takesFilename) {
      test('a `..` segment in the filename answers 400', async () => {
        const res = await route.call({
          token: userToken,
          key: { prefix: `${unique()}/inner`, filename: '../x.txt' },
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      });
    }

    test('an anonymous caller is refused before the key is read', async () => {
      const res = await route.call({
        key: { prefix: '/..', filename: '../x.txt' },
      });

      expect(res.status).toBe(401);
    });

    test('a caller without the action is refused before the key is read', async () => {
      const res = await route.call({
        token: noPermToken,
        key: { prefix: '/..', filename: '../x.txt' },
      });

      expect(res.status).toBe(route.refusal);
    });
  });
});
