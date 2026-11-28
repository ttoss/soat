import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A global policy carries no tenant data: any credential holding the policy
 * read in some project or project group lists and reads it; only the
 * unrestricted admin writes one.
 */
describe('Global policies read by tenant credentials', () => {
  let adminToken: string;
  let noPermToken: string;
  let projectId: string;
  let globalPolicyId: string;
  let projectPolicyId: string;
  const callers: Record<string, string> = {};

  const document = (project: string) => {
    return {
      statement: [
        {
          effect: 'Allow',
          action: ['files:GetFile'],
          resource: [`srn:${project}:*:*`],
        },
      ],
    };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'globalread',
      policyActions: [],
    });
    adminToken = setup.adminToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    const admin = authenticatedTestClient(adminToken);

    callers['project member'] = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'globalreadmember',
      actions: ['policies:ListPolicies', 'policies:GetPolicy', 'api-keys:*'],
    });
    const projectKey = await authenticatedTestClient(callers['project member'])
      .post('/api/v1/api-keys')
      .send({ name: 'project key', project_id: projectId });
    expect(projectKey.status).toBe(201);
    callers['project key'] = projectKey.body.key;

    const owner = await admin
      .post('/api/v1/users')
      .send({ username: 'globalreadowner', password: 'globalreadownerpass' });
    callers['project group owner'] = await loginAs(
      'globalreadowner',
      'globalreadownerpass'
    );
    const group = await admin
      .post('/api/v1/project-groups')
      .send({ name: 'Global readers', owner_id: owner.body.id });
    expect(group.status).toBe(201);
    const groupKey = await authenticatedTestClient(
      callers['project group owner']
    )
      .post('/api/v1/api-keys')
      .send({ name: 'group key', project_group_id: group.body.id });
    expect(groupKey.status).toBe(201);
    callers['project group key'] = groupKey.body.key;

    const global = await admin
      .post('/api/v1/policies')
      .send({ document: document(projectId) });
    expect(global.status).toBe(201);
    globalPolicyId = global.body.id;

    const project = await admin
      .post('/api/v1/policies')
      .send({ project_id: projectId, document: document(projectId) });
    expect(project.status).toBe(201);
    projectPolicyId = project.body.id;
  });

  const callerNames = () => {
    return [
      'project member',
      'project key',
      'project group owner',
      'project group key',
    ];
  };

  describe('GET /api/v1/policies?scope=global', () => {
    test('401 without a credential', async () => {
      const res = await testClient.get('/api/v1/policies?scope=global');

      expect(res.status).toBe(401);
    });

    test.each(callerNames())('a %s lists the global policies', async (name) => {
      const res = await authenticatedTestClient(callers[name]).get(
        '/api/v1/policies?scope=global&limit=100'
      );

      expect(res.status).toBe(200);
      const ids = res.body.data.map((p: { id: string }) => {
        return p.id;
      });
      expect(ids).toContain(globalPolicyId);
      expect(ids).not.toContain(projectPolicyId);
      for (const policy of res.body.data) {
        expect(policy).toMatchObject({
          project_id: null,
          project_group_id: null,
        });
      }
    });

    test('the unrestricted admin lists only the global policies', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/policies?scope=global&limit=100'
      );

      expect(res.status).toBe(200);
      const ids = res.body.data.map((p: { id: string }) => {
        return p.id;
      });
      expect(ids).toContain(globalPolicyId);
      expect(ids).not.toContain(projectPolicyId);
    });

    test('403 for a caller holding the policy read nowhere', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        '/api/v1/policies?scope=global'
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test.each(['project_id', 'project_group_id', 'user_id'])(
      '400 with %s',
      async (param) => {
        const res = await authenticatedTestClient(adminToken).get(
          `/api/v1/policies?scope=global&${param}=x`
        );

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    );

    test('400 for an unknown scope', async () => {
      const res = await authenticatedTestClient(callers['project key']).get(
        '/api/v1/policies?scope=tenant'
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/policies/:policy_id', () => {
    test('401 without a credential', async () => {
      const res = await testClient.get(`/api/v1/policies/${globalPolicyId}`);

      expect(res.status).toBe(401);
    });

    test.each(callerNames())('a %s reads a global policy', async (name) => {
      const res = await authenticatedTestClient(callers[name]).get(
        `/api/v1/policies/${globalPolicyId}`
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: globalPolicyId,
        project_id: null,
        project_group_id: null,
        document: document(projectId),
      });
    });

    test('403 for a caller holding the policy read nowhere', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/policies/${globalPolicyId}`
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test.each(callerNames())('an unknown id is 404 to a %s', async (name) => {
      const res = await authenticatedTestClient(callers[name]).get(
        '/api/v1/policies/pol_doesnotexist0000'
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('writes on a global policy', () => {
    test.each(callerNames())('a %s cannot update one', async (name) => {
      const res = await authenticatedTestClient(callers[name])
        .put(`/api/v1/policies/${globalPolicyId}`)
        .send({ document: document(projectId) });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test.each(callerNames())('a %s cannot delete one', async (name) => {
      const res = await authenticatedTestClient(callers[name]).delete(
        `/api/v1/policies/${globalPolicyId}`
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test.each(['project group owner', 'project group key'])(
      'a %s cannot create one',
      async (name) => {
        const res = await authenticatedTestClient(callers[name])
          .post('/api/v1/policies')
          .send({ document: document(projectId) });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    );
  });
});
