import { signRunToken } from 'src/lib/orchestrationRunToken';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The admin gate answers for the credential, not only the user behind it: an
 * admin's key bound to a project or narrowed by policies, and every
 * project-scoped token, carry a boundary the instance-wide routes would
 * otherwise step over.
 */
describe('Admin gate and credential scope', () => {
  let adminToken: string;
  let adminPublicId: string;
  let projectId: string;
  let otherProjectId: string;
  let readPolicyId: string;

  const mintAdminKey = async (args: {
    projectId?: string;
    policyIds?: string[];
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({
        name: 'Admin Gate Key',
        ...(args.projectId ? { project_id: args.projectId } : {}),
        ...(args.policyIds ? { policy_ids: args.policyIds } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.key as string;
  };

  const runToken = (): string => {
    return signRunToken({
      publicId: adminPublicId,
      role: 'admin',
      projectPublicId: projectId,
      workPublicId: 'orun_admingate',
    });
  };

  const adminRoutes = (token: string) => {
    const client = authenticatedTestClient(token);
    return [
      {
        name: 'GET /users',
        send: () => {
          return client.get('/api/v1/users');
        },
      },
      {
        name: 'GET /policies',
        send: () => {
          return client.get('/api/v1/policies');
        },
      },
      {
        name: 'POST /projects',
        send: () => {
          return client.post('/api/v1/projects').send({ name: 'agc-x' });
        },
      },
      {
        name: 'PUT /usage/prices',
        send: () => {
          return client.put('/api/v1/usage/prices').send({ prices: [] });
        },
      },
    ];
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'agc',
      policyActions: ['*'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    const me =
      await authenticatedTestClient(adminToken).get('/api/v1/users/me');
    adminPublicId = me.body.id;

    const readPolicy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['projects:GetProject'] }],
        },
      });
    readPolicyId = readPolicy.body.id;
  });

  describe('instance-wide admin routes', () => {
    test('admit an admin login token', async () => {
      for (const route of adminRoutes(adminToken)) {
        const res = await route.send();
        expect({ route: route.name, ok: res.status < 300 }).toEqual({
          route: route.name,
          ok: true,
        });
      }
    });

    test('admit an admin key bound to no project and no policy', async () => {
      const key = await mintAdminKey({});
      for (const route of adminRoutes(key)) {
        const res = await route.send();
        expect({ route: route.name, ok: res.status < 300 }).toEqual({
          route: route.name,
          ok: true,
        });
      }
    });

    test.each([
      ['an admin key bound to a project', 'project'],
      ['an admin key narrowed by policies', 'policies'],
      ['an admin run token', 'run'],
    ])('refuse %s with 403', async (_label, kind) => {
      const token =
        kind === 'run'
          ? runToken()
          : await mintAdminKey(
              kind === 'project' ? { projectId } : { policyIds: [readPolicyId] }
            );

      for (const route of adminRoutes(token)) {
        const res = await route.send();
        expect({ route: route.name, status: res.status }).toEqual({
          route: route.name,
          status: 403,
        });
      }
    });
  });

  describe('PATCH and DELETE /projects/{project_id}', () => {
    test('an admin key bound to the project updates it', async () => {
      const key = await mintAdminKey({ projectId });
      const res = await authenticatedTestClient(key)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ name: 'agc renamed' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('agc renamed');
    });

    test('an admin key bound to another project cannot update or delete it', async () => {
      const key = await mintAdminKey({ projectId });

      const patch = await authenticatedTestClient(key)
        .patch(`/api/v1/projects/${otherProjectId}`)
        .send({ name: 'hijacked' });
      expect(patch.status).toBe(403);
      expect(patch.body.error.code).toBe('API_KEY_PROJECT_SCOPE');

      const del = await authenticatedTestClient(key).delete(
        `/api/v1/projects/${otherProjectId}`
      );
      expect(del.status).toBe(403);
      expect(del.body.error.code).toBe('API_KEY_PROJECT_SCOPE');

      const still = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${otherProjectId}`
      );
      expect(still.status).toBe(200);
    });

    test('a run token for one project cannot update another', async () => {
      const res = await authenticatedTestClient(runToken())
        .patch(`/api/v1/projects/${otherProjectId}`)
        .send({ name: 'hijacked' });
      expect(res.status).toBe(403);
    });

    test('an admin key whose policies do not grant the action is refused on its own project', async () => {
      const key = await mintAdminKey({ projectId, policyIds: [readPolicyId] });
      const res = await authenticatedTestClient(key)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ name: 'narrowed' });
      expect(res.status).toBe(403);
    });
  });

  describe('formation resources gated to admins', () => {
    test('a policy resource is refused for an admin key bound to the project', async () => {
      const key = await mintAdminKey({ projectId });
      const res = await authenticatedTestClient(key)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'agc-policy-stack',
          template: {
            resources: {
              Escalation: {
                type: 'policy',
                properties: {
                  document: { statement: [{ effect: 'Allow', action: ['*'] }] },
                },
              },
            },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_actions).toEqual([
        {
          logical_id: 'Escalation',
          resource_type: 'policy',
          action: 'policies:CreatePolicy',
        },
      ]);
    });
  });
});
