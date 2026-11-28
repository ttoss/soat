import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A published global policy carries no tenant data: any credential holding
 * the policy read in some project or project group lists and reads it. An
 * unpublished one is `404` to it. Only the unrestricted admin writes either.
 */
describe('Global policies read by tenant credentials', () => {
  let adminToken: string;
  let noPermToken: string;
  let projectId: string;
  let projectGroupId: string;
  let foreignProjectGroupId: string;
  let globalPolicyId: string;
  let unpublishedPolicyId: string;
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
      actions: ['policies:*', 'api-keys:*'],
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
    projectGroupId = group.body.id;
    const groupKey = await authenticatedTestClient(
      callers['project group owner']
    )
      .post('/api/v1/api-keys')
      .send({ name: 'group key', project_group_id: group.body.id });
    expect(groupKey.status).toBe(201);
    callers['project group key'] = groupKey.body.key;

    const foreignOwner = await admin.post('/api/v1/users').send({
      username: 'globalreadforeign',
      password: 'globalreadforeignpass',
    });
    const foreign = await admin
      .post('/api/v1/project-groups')
      .send({ name: 'Foreign readers', owner_id: foreignOwner.body.id });
    expect(foreign.status).toBe(201);
    foreignProjectGroupId = foreign.body.id;

    const global = await admin
      .post('/api/v1/policies')
      .send({ document: document(projectId), published: true });
    expect(global.status).toBe(201);
    globalPolicyId = global.body.id;

    const unpublished = await admin
      .post('/api/v1/policies')
      .send({ document: document(projectId) });
    expect(unpublished.status).toBe(201);
    unpublishedPolicyId = unpublished.body.id;

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

    test.each(callerNames())(
      'a %s lists only the published global policies',
      async (name) => {
        const res = await authenticatedTestClient(callers[name]).get(
          '/api/v1/policies?scope=global&limit=100'
        );

        expect(res.status).toBe(200);
        const ids = res.body.data.map((p: { id: string }) => {
          return p.id;
        });
        expect(ids).toContain(globalPolicyId);
        expect(ids).not.toContain(unpublishedPolicyId);
        expect(ids).not.toContain(projectPolicyId);
        for (const policy of res.body.data) {
          expect(policy).toMatchObject({
            project_id: null,
            project_group_id: null,
            published: true,
          });
        }
      }
    );

    test('the unrestricted admin lists every global policy', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/policies?scope=global&limit=100'
      );

      expect(res.status).toBe(200);
      const ids = res.body.data.map((p: { id: string }) => {
        return p.id;
      });
      expect(ids).toContain(globalPolicyId);
      expect(ids).toContain(unpublishedPolicyId);
      expect(ids).not.toContain(projectPolicyId);
    });

    test('403 for a caller holding the policy read nowhere', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        '/api/v1/policies?scope=global'
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test.each(['project group owner', 'project group key'])(
      'a %s lists only the published global policies with its own project_group_id',
      async (name) => {
        const res = await authenticatedTestClient(callers[name]).get(
          `/api/v1/policies?scope=global&project_group_id=${projectGroupId}&limit=100`
        );

        expect(res.status).toBe(200);
        const ids = res.body.data.map((p: { id: string }) => {
          return p.id;
        });
        expect(ids).toContain(globalPolicyId);
        expect(ids).not.toContain(unpublishedPolicyId);
        expect(ids).not.toContain(projectPolicyId);
      }
    );

    test.each(['project group owner', 'project group key'])(
      'a project group beyond the reach of a %s is 404',
      async (name) => {
        const res = await authenticatedTestClient(callers[name]).get(
          `/api/v1/policies?scope=global&project_group_id=${foreignProjectGroupId}`
        );

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      }
    );

    test('the unrestricted admin lists every global policy with a project_group_id', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/policies?scope=global&project_group_id=${projectGroupId}&limit=100`
      );

      expect(res.status).toBe(200);
      const ids = res.body.data.map((p: { id: string }) => {
        return p.id;
      });
      expect(ids).toContain(globalPolicyId);
      expect(ids).toContain(unpublishedPolicyId);
    });

    test.each(['project_id', 'user_id'])('400 with %s', async (param) => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/policies?scope=global&${param}=x`
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

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
        published: true,
        document: document(projectId),
      });
    });

    test.each(callerNames())(
      'an unpublished global policy is 404 to a %s',
      async (name) => {
        const res = await authenticatedTestClient(callers[name]).get(
          `/api/v1/policies/${unpublishedPolicyId}`
        );

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      }
    );

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

    test.each(callerNames())(
      'an unpublished one is 404 to a %s writing it',
      async (name) => {
        const client = authenticatedTestClient(callers[name]);
        const path = `/api/v1/policies/${unpublishedPolicyId}`;

        const put = await client
          .put(path)
          .send({ document: document(projectId) });
        const del = await authenticatedTestClient(callers[name]).delete(path);

        expect([put.status, del.status]).toEqual([404, 404]);
      }
    );

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

  describe('published', () => {
    test('the unrestricted admin sets and clears it', async () => {
      const admin = authenticatedTestClient(adminToken);
      const created = await admin
        .post('/api/v1/policies')
        .send({ document: document(projectId) });
      expect(created.body.published).toBe(false);
      const path = `/api/v1/policies/${created.body.id}`;

      const set = await authenticatedTestClient(adminToken)
        .put(path)
        .send({ document: document(projectId), published: true });
      expect(set.status).toBe(200);
      expect(set.body.published).toBe(true);
      const kept = await authenticatedTestClient(adminToken)
        .put(path)
        .send({ document: document(projectId) });
      expect(kept.body.published).toBe(true);
      const cleared = await authenticatedTestClient(adminToken)
        .put(path)
        .send({ document: document(projectId), published: false });
      expect(cleared.status).toBe(200);
      expect(cleared.body.published).toBe(false);

      const read = await authenticatedTestClient(callers['project key']).get(
        path
      );
      expect(read.status).toBe(404);
    });

    test('400 when it is not a boolean', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({ document: document(projectId), published: 'yes' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('400 on a project policy, even from the unrestricted admin', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          project_id: projectId,
          document: document(projectId),
          published: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a project key cannot set it on its project policy', async () => {
      const res = await authenticatedTestClient(adminToken)
        .put(`/api/v1/policies/${projectPolicyId}`)
        .send({ document: document(projectId), published: false });
      const tenant = await authenticatedTestClient(callers['project key'])
        .post('/api/v1/policies')
        .send({ document: document(projectId), published: true });

      expect([res.status, tenant.status]).toEqual([400, 400]);
      expect(tenant.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a project group owner cannot set it on a project group policy', async () => {
      const res = await authenticatedTestClient(callers['project group owner'])
        .post('/api/v1/policies')
        .send({
          project_group_id: projectGroupId,
          document: { statement: [{ effect: 'Allow', action: ['*'] }] },
          published: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
