import fs from 'node:fs';

import { pathAddressedResourceTypes } from 'src/lib/policyCompiler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * Every write to a path-addressed resource asks IAM on the SRN of the path it
 * writes, so a grant scoped to a directory admits writes under it and refuses
 * the rest. A move asks on its destination as well as on the resource.
 */
describe('Path-addressed writes - path-scoped grants', () => {
  let adminToken: string;
  let projectId: string;
  let pathToken: string;
  let wildcardToken: string;

  const ACTIONS = [
    'documents:CreateDocument',
    'documents:IngestDocument',
    'documents:UpdateDocument',
    'files:UpdateFileMetadata',
  ];

  const principalWith = async (args: {
    username: string;
    resources: string[];
  }): Promise<string> => {
    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: args.username, password: 'pathwritepass' });
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            { effect: 'Allow', action: ACTIONS, resource: args.resources },
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
    return loginAs(args.username, 'pathwritepass');
  };

  const uploadSource = async (): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/files/upload/base64')
      .send({
        project_id: projectId,
        prefix: '/sources',
        filename: `source-${Math.random()}.txt`,
        content: Buffer.from('plain text body').toString('base64'),
        content_type: 'text/plain',
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'pathwrites',
      policyActions: ['documents:GetDocument'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    pathToken = await principalWith({
      username: 'pathwritespathuser',
      resources: [
        `srn:${projectId}:document:/allowed/*`,
        `srn:${projectId}:file:/allowed/*`,
      ],
    });
    wildcardToken = await principalWith({
      username: 'pathwriteswildcarduser',
      resources: [`srn:${projectId}:document:*`, `srn:${projectId}:file:*`],
    });
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  test('the path-addressed types are the field maps declaring a path', () => {
    expect(pathAddressedResourceTypes()).toEqual(['document', 'file']);
  });

  const writes = {
    'POST /documents (path)': async (args: { token: string; dir: string }) => {
      return authenticatedTestClient(args.token)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'body',
          path: `${args.dir}/doc-${Math.random()}.txt`,
        });
    },
    'POST /documents/ingest': async (args: { token: string; dir: string }) => {
      const fileId = await uploadSource();
      return authenticatedTestClient(args.token)
        .post('/api/v1/documents/ingest?wait=true')
        .send({
          project_id: projectId,
          file_id: fileId,
          path_prefix: args.dir,
        });
    },
    'PATCH /documents/{document_id} (move)': async (args: {
      token: string;
      dir: string;
    }) => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'body',
          path: `/allowed/move-${Math.random()}.txt`,
        });
      expect(created.status).toBe(201);
      return authenticatedTestClient(args.token)
        .patch(`/api/v1/documents/${created.body.id}`)
        .send({ path: `${args.dir}/moved-${Math.random()}.txt` });
    },
    'PATCH /files/{file_id}/metadata (move)': async (args: {
      token: string;
      dir: string;
    }) => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          prefix: '/allowed',
          filename: `move-${Math.random()}.txt`,
        });
      expect(created.status).toBe(201);
      return authenticatedTestClient(args.token)
        .patch(`/api/v1/files/${created.body.id}/metadata`)
        .send({ prefix: args.dir });
    },
  };

  const SUCCESS: Record<string, number> = {
    'POST /documents (path)': 201,
    'POST /documents/ingest': 201,
    'PATCH /documents/{document_id} (move)': 200,
    'PATCH /files/{file_id}/metadata (move)': 200,
  };

  describe.each(Object.entries(writes))('%s', (route, write) => {
    test('a grant on a directory admits a write under it', async () => {
      const res = await write({ token: pathToken, dir: '/allowed/sub' });
      expect(res.status).toBe(SUCCESS[route]);
    });

    test('a grant on a directory refuses a write outside it', async () => {
      const res = await write({ token: pathToken, dir: '/other' });
      expect(res.status).toBe(403);
    });

    test('a grant on a sibling-named directory refuses the write', async () => {
      const res = await write({ token: pathToken, dir: '/allowed-not' });
      expect(res.status).toBe(403);
    });

    test('a wildcard grant admits a write anywhere', async () => {
      const res = await write({ token: wildcardToken, dir: '/any' });
      expect(res.status).toBe(SUCCESS[route]);
    });
  });

  describe('POST /documents', () => {
    test('a filename with no path is judged as its root path', async () => {
      const res = await authenticatedTestClient(pathToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'body', filename: 'leaf.txt' });
      expect(res.status).toBe(403);
    });

    test('a document with no path or filename asks on document:*', async () => {
      const refused = await authenticatedTestClient(pathToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'body' });
      expect(refused.status).toBe(403);
      const admitted = await authenticatedTestClient(wildcardToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'body' });
      expect(admitted.status).toBe(201);
    });

    test('an unreadable path is refused on document:* first', async () => {
      const refused = await authenticatedTestClient(pathToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'body',
          path: '/allowed/../x',
        });
      expect(refused.status).toBe(403);
      const invalid = await authenticatedTestClient(wildcardToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'body',
          path: '/allowed/../x',
        });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /documents/ingest', () => {
    test('the stored path is the one the grant judged', async () => {
      const fileId = await uploadSource();
      const res = await authenticatedTestClient(pathToken)
        .post('/api/v1/documents/ingest?wait=true')
        .send({
          project_id: projectId,
          file_id: fileId,
          path_prefix: '/allowed',
        });
      expect(res.status).toBe(201);
      expect(res.body.path).toMatch(/^\/allowed\/source-[\d.]+\.txt$/);
    });

    test('a missing source file asks on document:*', async () => {
      const refused = await authenticatedTestClient(pathToken)
        .post('/api/v1/documents/ingest?wait=true')
        .send({
          project_id: projectId,
          file_id: 'file_missing',
          path_prefix: '/allowed',
        });
      expect(refused.status).toBe(403);
    });
  });

  describe('PATCH /documents/{document_id}', () => {
    test('clearing the path asks on document:*', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'body',
          path: '/allowed/clear.txt',
        });
      const res = await authenticatedTestClient(pathToken)
        .patch(`/api/v1/documents/${created.body.id}`)
        .send({ path: null });
      expect(res.status).toBe(403);
    });

    test('an edit that names no path asks only on the document', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'body',
          path: '/allowed/title.txt',
        });
      const res = await authenticatedTestClient(pathToken)
        .patch(`/api/v1/documents/${created.body.id}`)
        .send({ title: 'renamed' });
      expect(res.status).toBe(200);
    });
  });
});
