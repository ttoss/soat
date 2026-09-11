import fs from 'node:fs';

import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The compiled policy is the only thing standing between a caller and a row
 * they may not read, and every surface below reaches it through a different
 * lib function. `compilePolicy` is unit-tested against its own output shape;
 * these tests assert the shape actually survives the trip into the query.
 */
describe('Tag-conditioned policies filter list and search surfaces', () => {
  let adminToken: string;
  let restrictedToken: string;
  let projectId: string;
  let financeDocId: string;
  let engDocId: string;
  let financeFileId: string;
  let engFileId: string;

  const createDocument = async (args: {
    path: string;
    tags: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: `Content of ${args.path}`,
        path: args.path,
        tags: args.tags,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createFile = async (args: {
    filename: string;
    tags: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/files/upload/base64')
      .send({
        project_id: projectId,
        filename: args.filename,
        content: Buffer.from(`Content of ${args.filename}`).toString('base64'),
      });
    expect(res.status).toBe(201);

    const tagged = await authenticatedTestClient(adminToken)
      .put(`/api/v1/files/${res.body.id}/tags`)
      .send(args.tags);
    expect(tagged.status).toBe(200);

    return res.body.id as string;
  };

  const createUserWithPolicies = async (args: {
    username: string;
    statements: Array<Record<string, unknown>>;
  }) => {
    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: args.username, password: `${args.username}pass` });
    expect(userRes.status).toBe(201);

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({ document: { statement: args.statements } });
    expect(policyRes.status).toBe(201);

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    return loginAs(args.username, `${args.username}pass`);
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'tagcondadmin', password: 'supersecret' });
    adminToken = await loginAs('tagcondadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Tag Condition Project' });
    projectId = projectRes.body.id;

    financeDocId = await createDocument({
      path: '/handbook/payroll.txt',
      tags: { team: 'finance' },
    });
    engDocId = await createDocument({
      path: '/handbook/oncall.txt',
      tags: { team: 'eng' },
    });

    financeFileId = await createFile({
      filename: 'payroll.txt',
      tags: { team: 'finance' },
    });
    engFileId = await createFile({
      filename: 'oncall.txt',
      tags: { team: 'eng' },
    });

    restrictedToken = await createUserWithPolicies({
      username: 'tagcondrestricted',
      statements: [
        {
          effect: 'Allow',
          action: [
            'documents:ListDocuments',
            'files:GetFile',
            'knowledge:SearchKnowledge',
          ],
          resource: [`srn:${projectId}:*:*`],
          condition: {
            StringNotEquals: { 'soat:ResourceTag/team': 'finance' },
          },
        },
      ],
    });
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  test('GET /documents omits a document the condition excludes', async () => {
    const response = await authenticatedTestClient(restrictedToken)
      .get('/api/v1/documents')
      .query({ project_id: projectId });

    expect(response.status).toBe(200);
    const ids = response.body.data.map((d: { id: string }) => {
      return d.id;
    });
    expect(ids).toContain(engDocId);
    expect(ids).not.toContain(financeDocId);
  });

  test('GET /files omits a file the condition excludes', async () => {
    const response = await authenticatedTestClient(restrictedToken)
      .get('/api/v1/files')
      .query({ project_id: projectId });

    expect(response.status).toBe(200);
    const ids = response.body.data.map((f: { id: string }) => {
      return f.id;
    });
    expect(ids).toContain(engFileId);
    expect(ids).not.toContain(financeFileId);
  });

  test('POST /knowledge/search omits chunks of an excluded document', async () => {
    const response = await authenticatedTestClient(restrictedToken)
      .post('/api/v1/knowledge/search')
      .send({ project_id: projectId, document_paths: ['/handbook/'] });

    expect(response.status).toBe(200);
    const ids = response.body.results.map((r: { document_id: string }) => {
      return r.document_id;
    });
    expect(ids).toContain(engDocId);
    expect(ids).not.toContain(financeDocId);
  });

  test('admin, unfiltered, sees both — the exclusions above are the policy', async () => {
    const documents = await authenticatedTestClient(adminToken)
      .get('/api/v1/documents')
      .query({ project_id: projectId });
    const documentIds = documents.body.data.map((d: { id: string }) => {
      return d.id;
    });
    expect(documentIds).toEqual(
      expect.arrayContaining([engDocId, financeDocId])
    );

    const search = await authenticatedTestClient(adminToken)
      .post('/api/v1/knowledge/search')
      .send({ project_id: projectId, document_paths: ['/handbook/'] });
    const searchIds = search.body.results.map((r: { document_id: string }) => {
      return r.document_id;
    });
    expect(searchIds).toEqual(expect.arrayContaining([engDocId, financeDocId]));
  });

  describe('a path-scoped Deny, which compiles to a joined-column reference', () => {
    let pathDenyToken: string;

    beforeAll(async () => {
      await createDocument({
        path: '/private/secrets.txt',
        tags: { team: 'eng' },
      });

      pathDenyToken = await createUserWithPolicies({
        username: 'tagcondpathdeny',
        statements: [
          {
            effect: 'Allow',
            action: ['documents:ListDocuments', 'knowledge:SearchKnowledge'],
            resource: [`srn:${projectId}:*:*`],
          },
          {
            effect: 'Deny',
            action: ['documents:ListDocuments', 'knowledge:SearchKnowledge'],
            resource: [`srn:${projectId}:document:/private/*`],
          },
        ],
      });
    });

    test('GET /documents omits the denied directory', async () => {
      const response = await authenticatedTestClient(pathDenyToken)
        .get('/api/v1/documents')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      const paths = response.body.data.map((d: { path: string }) => {
        return d.path;
      });
      expect(paths).toContain('/handbook/oncall.txt');
      expect(paths).not.toContain('/private/secrets.txt');
    });

    test('POST /knowledge/search omits the denied directory', async () => {
      const response = await authenticatedTestClient(pathDenyToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, document_paths: ['/'] });

      expect(response.status).toBe(200);
      const paths = response.body.results.map((r: { path?: string }) => {
        return r.path;
      });
      expect(paths).toContain('/handbook/oncall.txt');
      expect(paths).not.toContain('/private/secrets.txt');
    });
  });
});
