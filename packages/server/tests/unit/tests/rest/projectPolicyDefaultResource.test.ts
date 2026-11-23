import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A project policy's `Allow` with no `resource` grants every resource of the
 * policy's project, never wider: every writer accepts it, the document is
 * stored as sent, and evaluation reads it as `srn:<project>:*:*`.
 */
describe('a project policy whose Allow omits resource', () => {
  let adminToken: string;
  let projectId: string;
  let otherProjectId: string;
  let documentId: string;
  let otherDocumentId: string;

  const noResource = {
    statement: [
      {
        effect: 'Allow',
        action: ['documents:ListDocuments', 'documents:GetDocument'],
      },
    ],
  };

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'defresadmin', password: 'supersecret' });
    adminToken = await loginAs('defresadmin', 'supersecret');

    const createProject = async (name: string) => {
      const res = await admin().post('/api/v1/projects').send({ name });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const createDocument = async (project: string) => {
      const res = await admin()
        .post('/api/v1/documents')
        .send({ project_id: project, content: 'Default', path: '/d.txt' });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    projectId = await createProject('Default Resource Project');
    otherProjectId = await createProject('Default Resource Other');
    documentId = await createDocument(projectId);
    otherDocumentId = await createDocument(otherProjectId);
  });

  describe('POST and PUT /api/v1/policies', () => {
    test('create is 201 and stores the document as sent', async () => {
      const res = await admin()
        .post('/api/v1/policies')
        .send({ project_id: projectId, document: noResource });

      expect(res.status).toBe(201);
      expect(res.body.document).toEqual(noResource);
    });

    test('update is 200 and stores the document as sent', async () => {
      const created = await admin()
        .post('/api/v1/policies')
        .send({
          project_id: projectId,
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['documents:GetDocument'],
                resource: [`srn:${projectId}:document:*`],
              },
            ],
          },
        });
      expect(created.status).toBe(201);

      const res = await admin()
        .put(`/api/v1/policies/${created.body.id}`)
        .send({ document: noResource });

      expect(res.status).toBe(200);
      expect(res.body.document).toEqual(noResource);
    });
  });

  describe('a user holding it', () => {
    let userToken: string;

    beforeAll(async () => {
      const policy = await admin()
        .post('/api/v1/policies')
        .send({ project_id: projectId, document: noResource });
      expect(policy.status).toBe(201);
      const user = await admin()
        .post('/api/v1/users')
        .send({ username: 'defresuser', password: 'defresuserpass' });
      expect(user.status).toBe(201);
      await admin()
        .put(`/api/v1/users/${user.body.id}/policies`)
        .send({ policy_ids: [policy.body.id] });
      userToken = await loginAs('defresuser', 'defresuserpass');
    });

    test("reads a document in the policy's project", async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${documentId}`
      );
      expect(res.status).toBe(200);
    });

    test('is refused a document in another project', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${otherDocumentId}`
      );
      expect(res.status).toBe(404);
    });

    test("lists only the policy's project without project_id", async () => {
      const res =
        await authenticatedTestClient(userToken).get('/api/v1/documents');
      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: string }>).map((d) => {
        return d.id;
      });
      expect(ids).toContain(documentId);
      expect(ids).not.toContain(otherDocumentId);
    });
  });

  describe('a formation declaring it', () => {
    const template = {
      resources: {
        ProjectWide: {
          type: 'policy',
          properties: { name: 'project-wide', document: noResource },
        },
      },
    };

    test('plans, deploys active and plans no-op after', async () => {
      const planned = await admin()
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, template });
      expect(planned.status).toBe(200);
      expect(planned.body.changes[0].action).toBe('create');

      const deployed = await admin()
        .post('/api/v1/formations')
        .send({ project_id: projectId, name: 'default-resource', template });
      expect(deployed.status).toBe(201);
      expect(deployed.body.status).toBe('active');

      const replanned = await admin().post('/api/v1/formations/plan').send({
        project_id: projectId,
        formation_id: deployed.body.id,
        template,
      });
      expect(replanned.status).toBe(200);
      expect(replanned.body.changes[0].action).toBe('no-op');
    });

    const allowOn = (resource: string[]) => {
      return {
        statement: [
          { effect: 'Allow', action: ['documents:GetDocument'], resource },
        ],
      };
    };

    test.each([
      ['an Allow on `*`', allowOn(['*']), /outside the policy's project/],
      [
        'an Allow on every project',
        allowOn(['srn:*:document:*']),
        /outside the policy's project/,
      ],
      [
        'an Allow on a project glob',
        allowOn(['srn:proj_*:document:*']),
        /outside the policy's project/,
      ],
      ['an Allow on a non-SRN pattern', allowOn(['doc_123']), /is invalid/],
      [
        'a malformed document',
        { statement: 'nope' },
        /must have a .*statement/,
      ],
    ])('validation refuses %s', async (_label, document, message) => {
      const res = await admin()
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: { Wide: { type: 'policy', properties: { document } } },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(JSON.stringify(res.body.errors)).toMatch(message);
    });
  });
});
