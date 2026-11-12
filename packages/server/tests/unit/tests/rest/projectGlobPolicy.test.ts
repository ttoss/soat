import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A policy naming projects by glob (`srn:<prefix>*:…`) reaches what
 * `isAllowed` matches: the project-less list and the `403`/`404` line agree
 * with a by-id read.
 */
describe('a user whose policy names projects by glob', () => {
  let adminToken: string;
  let globToken: string;
  let projectId: string;
  let documentId: string;
  let otherDocumentId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'globadmin', password: 'supersecret' });
    adminToken = await loginAs('globadmin', 'supersecret');

    const createProject = async (name: string) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const createDocument = async (project: string) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({ project_id: project, content: 'Glob', path: '/glob.txt' });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    projectId = await createProject('Glob Project');
    const otherProjectId = await createProject('Glob Other Project');
    documentId = await createDocument(projectId);
    otherDocumentId = await createDocument(otherProjectId);

    const policy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['documents:ListDocuments', 'documents:GetDocument'],
              resource: [`srn:${projectId.slice(0, -1)}*:document:*`],
            },
          ],
        },
      });
    expect(policy.status).toBe(201);

    const user = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'globuser', password: 'globuserpass' });
    expect(user.status).toBe(201);
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${user.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    globToken = await loginAs('globuser', 'globuserpass');
  });

  describe('GET /api/v1/documents', () => {
    test('without project_id lists the matched project only', async () => {
      const res =
        await authenticatedTestClient(globToken).get('/api/v1/documents');
      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: string }>).map((d) => {
        return d.id;
      });
      expect(ids).toContain(documentId);
      expect(ids).not.toContain(otherDocumentId);
    });
  });

  describe('DELETE /api/v1/documents/:document_id', () => {
    test('refuses a document in the matched project with 403', async () => {
      const res = await authenticatedTestClient(globToken).delete(
        `/api/v1/documents/${documentId}`
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('hides a document in an unmatched project with 404', async () => {
      const res = await authenticatedTestClient(globToken).delete(
        `/api/v1/documents/${otherDocumentId}`
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });
});
