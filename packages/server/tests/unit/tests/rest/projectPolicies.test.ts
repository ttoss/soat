import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A policy with a `project_id` belongs to that project: its document grants
 * only there, and whoever holds `policies:*` there manages it. A policy
 * without one is global and stays the unrestricted admin's.
 */
describe('Project policies', () => {
  let adminToken: string;
  let projectId: string;
  let otherProjectId: string;
  let projectAdminToken: string;
  let projectKey: string;
  let noPolicyActionsToken: string;
  let globalPolicyId: string;
  let otherProjectPolicyId: string;

  const allowIn = (args: { project: string; action?: string[] }) => {
    return {
      statement: [
        {
          effect: 'Allow',
          action: args.action ?? ['files:GetFile'],
          resource: [`srn:${args.project}:*:*`],
        },
      ],
    };
  };

  const createProjectPolicy = async (args: {
    token: string;
    project?: string;
    document?: object;
  }) => {
    const res = await authenticatedTestClient(args.token)
      .post('/api/v1/policies')
      .send({
        ...(args.project ? { project_id: args.project } : {}),
        document: args.document ?? allowIn({ project: projectId }),
      });
    return res;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'projpol',
      policyActions: ['files:GetFile'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    projectAdminToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'projpolmanager',
      actions: ['policies:*', 'files:GetFile', 'webhooks:*', 'api-keys:*'],
    });
    noPolicyActionsToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'projpolreader',
      actions: ['files:GetFile'],
    });

    const keyRes = await authenticatedTestClient(projectAdminToken)
      .post('/api/v1/api-keys')
      .send({ name: 'projpol key', project_id: projectId });
    expect(keyRes.status).toBe(201);
    projectKey = keyRes.body.key;

    const globalRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({ document: allowIn({ project: projectId }) });
    globalPolicyId = globalRes.body.id;

    const otherRes = await createProjectPolicy({
      token: adminToken,
      project: otherProjectId,
      document: allowIn({ project: otherProjectId }),
    });
    expect(otherRes.status).toBe(201);
    otherProjectPolicyId = otherRes.body.id;
  });

  describe('POST /api/v1/policies', () => {
    test('a project admin creates a policy in its project', async () => {
      const res = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
      });

      expect(res.status).toBe(201);
      expect(res.body.project_id).toBe(projectId);
    });

    test("a project key creates one in its key's project without naming it", async () => {
      const res = await createProjectPolicy({ token: projectKey });

      expect(res.status).toBe(201);
      expect(res.body.project_id).toBe(projectId);
    });

    test('an admin without project_id creates a global policy', async () => {
      const res = await createProjectPolicy({ token: adminToken });

      expect(res.status).toBe(201);
      expect(res.body.project_id).toBeNull();
    });

    test('a project admin cannot create a global policy', async () => {
      const res = await createProjectPolicy({ token: projectAdminToken });

      expect(res.status).toBe(403);
    });

    test('a project key cannot create one in another project', async () => {
      const res = await createProjectPolicy({
        token: projectKey,
        project: otherProjectId,
        document: allowIn({ project: otherProjectId }),
      });

      expect(res.status).toBe(403);
    });

    test('a caller without policies:CreatePolicy in the project gets 403', async () => {
      const res = await createProjectPolicy({
        token: noPolicyActionsToken,
        project: projectId,
      });

      expect(res.status).toBe(403);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/policies').send({
        project_id: projectId,
        document: allowIn({ project: projectId }),
      });

      expect(res.status).toBe(401);
    });

    test.each([
      ['a `*` resource', ['*']],
      ['another project', ['srn:OTHER:*:*']],
      ['every project', ['srn:*:file:*']],
      ['a project glob', ['srn:proj_*:file:*']],
      ['an unscoped resource', ['file_123']],
    ])('an Allow on %s is 400', async (_label, resource) => {
      const res = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['files:GetFile'],
              resource: resource.map((r) => {
                return r.replace('OTHER', otherProjectId);
              }),
            },
          ],
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an Allow with no resource is 400', async () => {
      const res = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      });

      expect(res.status).toBe(400);
    });

    test('a Deny on any resource is accepted', async () => {
      const res = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['files:GetFile'],
              resource: [`srn:${projectId}:file:*`],
            },
            { effect: 'Deny', action: ['files:DeleteFile'], resource: ['*'] },
          ],
        },
      });

      expect(res.status).toBe(201);
    });
  });

  describe('GET /api/v1/policies', () => {
    test("a project admin lists only its project's policies", async () => {
      const created = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
      });

      const res = await authenticatedTestClient(projectAdminToken).get(
        `/api/v1/policies?project_id=${projectId}`
      );

      expect(res.status).toBe(200);
      const ids = res.body.data.map((p: { id: string }) => {
        return p.id;
      });
      expect(ids).toContain(created.body.id);
      expect(ids).not.toContain(globalPolicyId);
      expect(ids).not.toContain(otherProjectPolicyId);
      for (const policy of res.body.data) {
        expect(policy.project_id).toBe(projectId);
      }
    });

    test("a project key lists only its project's policies", async () => {
      const res =
        await authenticatedTestClient(projectKey).get('/api/v1/policies');

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const policy of res.body.data) {
        expect(policy.project_id).toBe(projectId);
      }
    });

    test('a caller without policies:ListPolicies gets 403', async () => {
      const res = await authenticatedTestClient(noPolicyActionsToken).get(
        `/api/v1/policies?project_id=${projectId}`
      );

      expect(res.status).toBe(403);
    });

    test('an unrestricted admin lists global and project policies', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/policies?limit=100'
      );

      const ids = res.body.data.map((p: { id: string }) => {
        return p.id;
      });
      expect(ids).toContain(globalPolicyId);
      expect(ids).toContain(otherProjectPolicyId);
    });

    test('an unrestricted admin filters by project_id', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/policies?project_id=${otherProjectId}`
      );

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((p: { id: string }) => {
          return p.id;
        })
      ).toEqual([otherProjectPolicyId]);
    });
  });

  describe('GET, PUT and DELETE /api/v1/policies/:policy_id', () => {
    test('a project admin reads, updates and deletes its project policy', async () => {
      const created = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
      });
      const path = `/api/v1/policies/${created.body.id}`;
      const client = authenticatedTestClient(projectAdminToken);

      const read = await client.get(path);
      expect(read.status).toBe(200);
      expect(read.body.project_id).toBe(projectId);

      const updated = await authenticatedTestClient(projectAdminToken)
        .put(path)
        .send({
          name: 'renamed',
          document: allowIn({ project: projectId, action: ['files:*'] }),
        });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe('renamed');
      expect(updated.body.project_id).toBe(projectId);

      const deleted =
        await authenticatedTestClient(projectAdminToken).delete(path);
      expect(deleted.status).toBe(204);
    });

    test('a project key reads its project policy', async () => {
      const created = await createProjectPolicy({ token: projectKey });

      const res = await authenticatedTestClient(projectKey).get(
        `/api/v1/policies/${created.body.id}`
      );

      expect(res.status).toBe(200);
    });

    test.each(['get', 'put', 'delete'] as const)(
      'a global policy is 403 to a project caller (%s)',
      async (method) => {
        const req = authenticatedTestClient(projectAdminToken)[method](
          `/api/v1/policies/${globalPolicyId}`
        );
        const res =
          method === 'put'
            ? await req.send({ document: allowIn({ project: projectId }) })
            : await req;

        expect(res.status).toBe(403);
      }
    );

    test.each(['get', 'put', 'delete'] as const)(
      "another project's policy is 404 to a project key (%s)",
      async (method) => {
        const req = authenticatedTestClient(projectKey)[method](
          `/api/v1/policies/${otherProjectPolicyId}`
        );
        const res =
          method === 'put'
            ? await req.send({ document: allowIn({ project: otherProjectId }) })
            : await req;

        expect(res.status).toBe(404);
      }
    );

    test.each(['get', 'put', 'delete'] as const)(
      'an unknown policy id is 404 to a project key (%s)',
      async (method) => {
        const req = authenticatedTestClient(projectKey)[method](
          '/api/v1/policies/pol_doesnotexist0000'
        );
        const res =
          method === 'put'
            ? await req.send({ document: allowIn({ project: projectId }) })
            : await req;

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      }
    );

    test('an update granting outside the policy project is 400', async () => {
      const created = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
      });

      const res = await authenticatedTestClient(projectAdminToken)
        .put(`/api/v1/policies/${created.body.id}`)
        .send({ document: allowIn({ project: otherProjectId }) });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an admin update of a project policy keeps it in its project', async () => {
      const res = await authenticatedTestClient(adminToken)
        .put(`/api/v1/policies/${otherProjectPolicyId}`)
        .send({
          document: { statement: [{ effect: 'Allow', action: ['*'] }] },
        });

      expect(res.status).toBe(400);
    });

    test('a caller without policies:GetPolicy reads 404', async () => {
      const created = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
      });

      const res = await authenticatedTestClient(noPolicyActionsToken).get(
        `/api/v1/policies/${created.body.id}`
      );

      expect(res.status).toBe(404);
    });

    test('a caller without policies:DeletePolicy is refused with 403', async () => {
      const created = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
      });

      const res = await authenticatedTestClient(noPolicyActionsToken).delete(
        `/api/v1/policies/${created.body.id}`
      );

      expect(res.status).toBe(403);
    });
  });

  describe('policy_ids', () => {
    const createWebhook = (args: {
      token: string;
      project: string;
      policyIds: string[];
    }) => {
      return authenticatedTestClient(args.token)
        .post('/api/v1/webhooks')
        .send({
          project_id: args.project,
          name: 'projpol hook',
          url: 'https://example.com/hook',
          events: ['*'],
          policy_ids: args.policyIds,
        });
    };

    test("a resource may carry its own project's policy", async () => {
      const policy = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
      });

      const res = await createWebhook({
        token: projectAdminToken,
        project: projectId,
        policyIds: [policy.body.id],
      });

      expect(res.status).toBe(201);
    });

    test('a resource may carry a global policy', async () => {
      const res = await createWebhook({
        token: adminToken,
        project: projectId,
        policyIds: [globalPolicyId],
      });

      expect(res.status).toBe(201);
    });

    test("another project's policy is 400 POLICY_OUTSIDE_PROJECT", async () => {
      const res = await createWebhook({
        token: adminToken,
        project: projectId,
        policyIds: [otherProjectPolicyId],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('POLICY_OUTSIDE_PROJECT');
    });

    test("an update naming another project's policy is 400", async () => {
      const created = await createWebhook({
        token: adminToken,
        project: projectId,
        policyIds: [globalPolicyId],
      });

      const res = await authenticatedTestClient(adminToken)
        .put(`/api/v1/webhooks/${created.body.id}`)
        .send({ policy_ids: [otherProjectPolicyId] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('POLICY_OUTSIDE_PROJECT');
    });

    test('attaching a project policy granting more than the writer holds is 403', async () => {
      const wider = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
        document: allowIn({ project: projectId, action: ['agents:*'] }),
      });

      const res = await createWebhook({
        token: projectAdminToken,
        project: projectId,
        policyIds: [wider.body.id],
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
    });

    test('widening an attached project policy past the editor is 403', async () => {
      const policy = await createProjectPolicy({
        token: projectAdminToken,
        project: projectId,
      });
      const hook = await createWebhook({
        token: projectAdminToken,
        project: projectId,
        policyIds: [policy.body.id],
      });
      expect(hook.status).toBe(201);

      const res = await authenticatedTestClient(projectAdminToken)
        .put(`/api/v1/policies/${policy.body.id}`)
        .send({
          document: allowIn({ project: projectId, action: ['agents:*'] }),
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
    });
  });
});
