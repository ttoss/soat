import fs from 'node:fs';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs } from '../../testClient';

describe('FileTags', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;

  const upload = async (name: string) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from(name), {
        filename: `${name}.txt`,
        contentType: 'text/plain',
      })
      .field('project_id', projectId);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'filetags',
      policyActions: [
        'files:UploadFile',
        'files:GetFile',
        'files:UpdateFileMetadata',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('tag body validation', () => {
    let fileId: string;

    beforeAll(async () => {
      fileId = await upload('tag-validation');
    });

    test('PUT tags rejects a non-string tag value', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/files/${fileId}/tags`)
        .send({ team: null });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('PATCH tags rejects an array body', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/tags`)
        .send(['a']);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/files with tag filter', () => {
    let taggedId: string;
    let otherId: string;

    beforeAll(async () => {
      taggedId = await upload('tagged-list');
      await authenticatedTestClient(userToken)
        .put(`/api/v1/files/${taggedId}/tags`)
        .send({ kind: 'invoice' });

      otherId = await upload('other-list');
      await authenticatedTestClient(userToken)
        .put(`/api/v1/files/${otherId}/tags`)
        .send({ kind: 'receipt' });
    });

    test('a key:value pair returns only files carrying it', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/files')
        .query({ project_id: projectId, tags: 'kind:invoice' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((f: { id: string }) => {
        return f.id;
      });
      expect(ids).toContain(taggedId);
      expect(ids).not.toContain(otherId);
    });

    test('the filter also applies without project_id', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/files')
        .query({ tags: 'kind:receipt' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((f: { id: string }) => {
        return f.id;
      });
      expect(ids).toContain(otherId);
      expect(ids).not.toContain(taggedId);
    });

    test('a pair without a colon is rejected', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/files')
        .query({ project_id: projectId, tags: 'invoice' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/files/{file_id} — file policy resources', () => {
    let pathUserToken: string;
    let tagUserToken: string;
    let reportId: string;
    let otherPathId: string;
    let prodId: string;
    let devId: string;

    const principalWith = async (args: {
      username: string;
      statement: Record<string, unknown>;
    }): Promise<string> => {
      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: args.username, password: 'filepolicypass' });
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({ document: { statement: [args.statement] } });
      expect(policyRes.status).toBe(201);
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userRes.body.id}/policies`)
        .send({ policy_ids: [policyRes.body.id] });
      await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ user_id: userRes.body.id });
      return loginAs(args.username, 'filepolicypass');
    };

    const uploadAt = async (args: { name: string; prefix: string }) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from(args.name), {
          filename: `${args.name}.txt`,
          contentType: 'text/plain',
        })
        .field('project_id', projectId)
        .field('prefix', args.prefix);
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    beforeAll(async () => {
      reportId = await uploadAt({ name: 'quarterly', prefix: '/reports/' });
      otherPathId = await uploadAt({ name: 'scratch', prefix: '/drafts/' });
      prodId = await upload('tagged-prod');
      devId = await upload('tagged-dev');
      await authenticatedTestClient(userToken)
        .put(`/api/v1/files/${prodId}/tags`)
        .send({ env: 'prod' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/files/${devId}/tags`)
        .send({ env: 'dev' });

      pathUserToken = await principalWith({
        username: 'filetagspathuser',
        statement: {
          effect: 'Allow',
          action: ['files:GetFile'],
          resource: [`srn:${projectId}:file:/reports/*`],
        },
      });
      tagUserToken = await principalWith({
        username: 'filetagstaguser',
        statement: {
          effect: 'Allow',
          action: ['files:GetFile'],
          resource: ['*'],
          condition: { StringEquals: { 'soat:ResourceTag/env': 'prod' } },
        },
      });
    });

    test('a policy naming a path grants the file stored at it', async () => {
      const response = await authenticatedTestClient(pathUserToken).get(
        `/api/v1/files/${reportId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(reportId);
      expect(response.body.path).toBe('/reports/quarterly.txt');
    });

    test('a policy naming a path does not grant a file outside it', async () => {
      const response = await authenticatedTestClient(pathUserToken).get(
        `/api/v1/files/${otherPathId}`
      );

      expect(response.status).toBe(403);
    });

    test('a file with no path is granted by a policy naming its id', async () => {
      const doc = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'pathless' });
      expect(doc.status).toBe(201);
      const cleared = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/documents/${doc.body.id}`)
        .send({ path: null });
      expect(cleared.status).toBe(200);
      const fileId = doc.body.file_id as string;
      const idUserToken = await principalWith({
        username: 'filetagsiduser',
        statement: {
          effect: 'Allow',
          action: ['files:GetFile'],
          resource: [`srn:${projectId}:file:${fileId}`],
        },
      });

      const response = await authenticatedTestClient(idUserToken).get(
        `/api/v1/files/${fileId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(fileId);
      expect(response.body.path ?? null).toBeNull();
    });

    test('a tag condition grants a file carrying the tag', async () => {
      const response = await authenticatedTestClient(tagUserToken).get(
        `/api/v1/files/${prodId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(prodId);
    });

    test('a tag condition does not grant a file with another value', async () => {
      const response = await authenticatedTestClient(tagUserToken).get(
        `/api/v1/files/${devId}`
      );

      expect(response.status).toBe(403);
    });
  });
});
