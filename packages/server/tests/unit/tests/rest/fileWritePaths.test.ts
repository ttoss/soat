import fs from 'node:fs';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * Every file write asks IAM on the SRN of the path it writes, so a grant
 * scoped to a directory admits writes under it and refuses the rest.
 */
describe('File writes - path-scoped grants', () => {
  let adminToken: string;
  let projectId: string;
  let pathToken: string;
  let wildcardToken: string;

  const principalWith = async (args: {
    username: string;
    resource: string;
  }): Promise<string> => {
    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: args.username, password: 'filewritepass' });
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['files:CreateFile', 'files:UploadFile'],
              resource: [args.resource],
            },
          ],
        },
      });
    expect(policyRes.status).toBe(201);
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });
    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: userRes.body.id });
    return loginAs(args.username, 'filewritepass');
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'filewrites',
      policyActions: ['files:GetFile'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    pathToken = await principalWith({
      username: 'filewritespathuser',
      resource: `srn:${projectId}:file:/allowed/*`,
    });
    wildcardToken = await principalWith({
      username: 'filewriteswildcarduser',
      resource: `srn:${projectId}:file:*`,
    });
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const writes = {
    'POST /files': (args: { token: string; prefix: string; name: string }) => {
      return authenticatedTestClient(args.token).post('/api/v1/files').send({
        project_id: projectId,
        prefix: args.prefix,
        filename: args.name,
      });
    },
    'POST /files/upload': (args: {
      token: string;
      prefix: string;
      name: string;
    }) => {
      return authenticatedTestClient(args.token)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('bytes'), {
          filename: args.name,
          contentType: 'text/plain',
        })
        .field('project_id', projectId)
        .field('prefix', args.prefix);
    },
    'POST /files/upload/base64': (args: {
      token: string;
      prefix: string;
      name: string;
    }) => {
      return authenticatedTestClient(args.token)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: projectId,
          content: Buffer.from('bytes').toString('base64'),
          prefix: args.prefix,
          filename: args.name,
          content_type: 'text/plain',
        });
    },
    'POST /files/presigned-url': (args: {
      token: string;
      prefix: string;
      name: string;
    }) => {
      return authenticatedTestClient(args.token)
        .post('/api/v1/files/presigned-url')
        .send({
          project_id: projectId,
          prefix: args.prefix,
          filename: args.name,
        });
    },
  };

  describe.each(Object.entries(writes))('%s', (route, write) => {
    const name = `${route.replace(/\W+/g, '-')}.txt`;

    test('a grant on a directory admits a write under it', async () => {
      const res = await write({ token: pathToken, prefix: '/allowed', name });
      expect(res.status).toBe(201);
    });

    test('a grant on a directory refuses a write outside it', async () => {
      const res = await write({ token: pathToken, prefix: '/other', name });
      expect(res.status).toBe(403);
    });

    test('a grant on a sibling-named directory refuses the write', async () => {
      const res = await write({
        token: pathToken,
        prefix: '/allowed-not',
        name,
      });
      expect(res.status).toBe(403);
    });

    test('a file:* grant admits a write anywhere', async () => {
      const res = await write({ token: wildcardToken, prefix: '/any', name });
      expect(res.status).toBe(201);
    });
  });

  test('the multipart filename is the leaf the grant judges', async () => {
    const res = await authenticatedTestClient(pathToken)
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from('bytes'), {
        filename: 'leaf.txt',
        contentType: 'text/plain',
      })
      .field('project_id', projectId)
      .field('prefix', '/allowed');
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('/allowed/leaf.txt');
  });
});
