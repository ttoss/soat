import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('policies of a project group', () => {
  let adminToken: string;
  let ownerToken: string;
  let ownerId: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let projectGroupId: string;
  let otherProjectGroupId: string;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createGroupPolicy = (args: {
    token?: string;
    document: unknown;
    projectGroupId?: string;
    projectId?: string;
  }) => {
    return authenticatedTestClient(args.token ?? ownerToken)
      .post('/api/v1/policies')
      .send({
        project_group_id: args.projectGroupId ?? projectGroupId,
        ...(args.projectId ? { project_id: args.projectId } : {}),
        document: args.document,
      });
  };

  const groupPolicy = async (document: unknown, token?: string) => {
    const res = await createGroupPolicy({ document, token });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const check = async (token: string, action: string, resource: string) => {
    const res = await authenticatedTestClient(token)
      .post('/api/v1/iam/check')
      .send({ action, resource });
    expect(res.status).toBe(200);
    return res.body.allowed as boolean;
  };

  const groupSrn = (type?: string) => {
    return type
      ? `srn:project-group:${projectGroupId}:${type}/*`
      : `srn:project-group:${projectGroupId}:*`;
  };

  const mintKey = async (body: Record<string, unknown>, token = ownerToken) => {
    return authenticatedTestClient(token)
      .post('/api/v1/api-keys')
      .send({ name: 'group key', ...body });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'grouppolicies',
      policyActions: ['secrets:*', 'iam:*', 'policies:*'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    ownerToken = setup.userToken;
    ownerId = setup.userId;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;
    const group = await admin()
      .post('/api/v1/project-groups')
      .send({ name: 'Acme', owner_id: ownerId });
    projectGroupId = group.body.id;
    await admin().put(
      `/api/v1/project-groups/${projectGroupId}/projects/${projectId}`
    );
    const other = await admin()
      .post('/api/v1/project-groups')
      .send({ name: 'Other', owner_id: ownerId });
    otherProjectGroupId = other.body.id;
  });

  describe('POST /api/v1/policies with project_group_id', () => {
    test('401 without a credential', async () => {
      const res = await testClient.post('/api/v1/policies').send({
        project_group_id: projectGroupId,
        document: { statement: [{ effect: 'Allow', action: ['*'] }] },
      });
      expect(res.status).toBe(401);
    });

    test('the owner creates one, belonging to the project group', async () => {
      const res = await createGroupPolicy({
        document: {
          statement: [
            { effect: 'Allow', action: ['secrets:ListSecrets'] },
            {
              effect: 'Allow',
              action: ['project-groups:GetProjectGroup'],
              resource: [groupSrn()],
            },
          ],
        },
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        project_id: null,
        project_group_id: projectGroupId,
      });
    });

    test('the owner holds project-groups:CreatePolicy on the group policies', async () => {
      expect(
        await check(
          ownerToken,
          'project-groups:CreatePolicy',
          groupSrn('policy')
        )
      ).toBe(true);
      expect(
        await check(
          noPermToken,
          'project-groups:CreatePolicy',
          groupSrn('policy')
        )
      ).toBe(false);
    });

    test('404 for anyone who may not read the project group', async () => {
      const res = await createGroupPolicy({
        token: noPermToken,
        document: { statement: [{ effect: 'Allow', action: ['*'] }] },
      });
      expect(res.status).toBe(404);
    });

    test('403 when a project group policy denies CreatePolicy to its owner', async () => {
      const deny = await groupPolicy({
        statement: [
          { effect: 'Allow', action: ['*'] },
          { effect: 'Deny', action: ['project-groups:CreatePolicy'] },
        ],
      });
      const { key } = (
        await mintKey({ project_group_id: projectGroupId, policy_ids: [deny] })
      ).body;
      const res = await createGroupPolicy({
        token: key,
        document: { statement: [{ effect: 'Allow', action: ['*'] }] },
      });
      expect(res.status).toBe(403);
    });

    test('400 naming both project_id and project_group_id', async () => {
      const res = await createGroupPolicy({
        projectId,
        document: { statement: [{ effect: 'Allow', action: ['*'] }] },
      });
      expect(res.status).toBe(400);
    });

    test('400 for an Allow resource outside the project group', async () => {
      for (const resource of [
        '*',
        `srn:${otherProjectId}:secret:*`,
        'srn:*:secret:*',
        `srn:project-group:${otherProjectGroupId}:*`,
      ]) {
        const res = await createGroupPolicy({
          document: {
            statement: [
              { effect: 'Allow', action: ['secrets:*'], resource: [resource] },
            ],
          },
        });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    test("the project group's own resources and its projects' are inside", async () => {
      const res = await createGroupPolicy({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['secrets:*', 'project-groups:GetUsage'],
              resource: [`srn:${projectId}:secret:*`, groupSrn('usage')],
            },
          ],
        },
      });
      expect(res.status).toBe(201);
    });

    test('a project-scoped key creates none', async () => {
      const { key } = (await mintKey({ project_id: projectId })).body;
      const res = await createGroupPolicy({
        token: key,
        document: { statement: [{ effect: 'Allow', action: ['*'] }] },
      });
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('reading, listing, updating and deleting one', () => {
    let policyId: string;

    beforeAll(async () => {
      policyId = await groupPolicy({
        statement: [{ effect: 'Allow', action: ['secrets:ListSecrets'] }],
      });
    });

    test('the owner lists the project group policies, and only them', async () => {
      const res = await authenticatedTestClient(ownerToken).get(
        `/api/v1/policies?project_group_id=${projectGroupId}`
      );
      expect(res.status).toBe(200);
      const ids = res.body.data.map((policy: { id: string }) => {
        return policy.id;
      });
      expect(ids).toContain(policyId);
      for (const policy of res.body.data) {
        expect(policy.project_group_id).toBe(projectGroupId);
      }
    });

    test('anyone else gets 404 listing them', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/policies?project_group_id=${projectGroupId}`
      );
      expect(res.status).toBe(404);
    });

    test('a project listing holds no project group policy', async () => {
      const res = await admin().get(`/api/v1/policies?project_id=${projectId}`);
      expect(res.status).toBe(200);
      expect(
        res.body.data.some((policy: { id: string }) => {
          return policy.id === policyId;
        })
      ).toBe(false);
    });

    test('the owner reads it; anyone else gets 404', async () => {
      const res = await authenticatedTestClient(ownerToken).get(
        `/api/v1/policies/${policyId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.project_group_id).toBe(projectGroupId);
      const hidden = await authenticatedTestClient(noPermToken).get(
        `/api/v1/policies/${policyId}`
      );
      expect(hidden.status).toBe(404);
    });

    test('an update stays inside the project group', async () => {
      const outside = await authenticatedTestClient(ownerToken)
        .put(`/api/v1/policies/${policyId}`)
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['secrets:*'],
                resource: [`srn:${otherProjectId}:secret:*`],
              },
            ],
          },
        });
      expect(outside.status).toBe(400);
      const inside = await authenticatedTestClient(ownerToken)
        .put(`/api/v1/policies/${policyId}`)
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['secrets:GetSecret'] }],
          },
        });
      expect(inside.status).toBe(200);
      expect(inside.body.project_group_id).toBe(projectGroupId);
    });

    test('anyone else updates and deletes nothing', async () => {
      const update = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/policies/${policyId}`)
        .send({
          document: { statement: [{ effect: 'Allow', action: ['*'] }] },
        });
      expect(update.status).toBe(404);
      const remove = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/policies/${policyId}`
      );
      expect(remove.status).toBe(404);
    });

    test('the owner deletes it', async () => {
      const res = await authenticatedTestClient(ownerToken).delete(
        `/api/v1/policies/${policyId}`
      );
      expect(res.status).toBe(204);
    });
  });

  describe('where it may be attached', () => {
    let policyId: string;

    beforeAll(async () => {
      policyId = await groupPolicy({
        statement: [
          {
            effect: 'Allow',
            action: ['secrets:ListSecrets', 'project-groups:GetProjectGroup'],
          },
        ],
      });
    });

    test('a key of the project group acts under it, inside the project group', async () => {
      const res = await mintKey({
        project_group_id: projectGroupId,
        policy_ids: [policyId],
      });
      expect(res.status).toBe(201);
      const { key } = res.body;
      expect(
        await check(key, 'secrets:ListSecrets', `srn:${projectId}:secret:*`)
      ).toBe(true);
      expect(
        await check(key, 'project-groups:GetProjectGroup', groupSrn())
      ).toBe(true);
      expect(
        await check(key, 'project-groups:CreateApiKey', groupSrn('api_key'))
      ).toBe(false);
      expect(
        await check(
          key,
          'secrets:ListSecrets',
          `srn:${otherProjectId}:secret:*`
        )
      ).toBe(false);
    });

    test("the project group's own policy_ids take it, held by its owner", async () => {
      const deny = await groupPolicy({
        statement: [
          { effect: 'Allow', action: ['project-groups:*', 'secrets:*'] },
          { effect: 'Deny', action: ['project-groups:GetUsage'] },
        ],
      });
      const res = await authenticatedTestClient(ownerToken)
        .patch(`/api/v1/project-groups/${projectGroupId}`)
        .send({ policy_ids: [deny] });
      expect(res.status).toBe(200);
      expect(
        await check(ownerToken, 'project-groups:GetUsage', groupSrn('usage'))
      ).toBe(false);
      const detached = await authenticatedTestClient(ownerToken)
        .patch(`/api/v1/project-groups/${projectGroupId}`)
        .send({ policy_ids: [] });
      expect(detached.status).toBe(200);
    });

    test('an attached one cannot be deleted', async () => {
      await mintKey({
        project_group_id: projectGroupId,
        policy_ids: [policyId],
      });
      const res = await authenticatedTestClient(ownerToken).delete(
        `/api/v1/policies/${policyId}`
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('POLICY_HAS_DEPENDENTS');
    });

    test('another project group, a project key, an unscoped key or a user takes none of it', async () => {
      const otherGroup = await authenticatedTestClient(ownerToken)
        .patch(`/api/v1/project-groups/${otherProjectGroupId}`)
        .send({ policy_ids: [policyId] });
      expect(otherGroup.status).toBe(400);
      expect(otherGroup.body.error.code).toBe('POLICY_OUTSIDE_PROJECT');
      const otherGroupKey = await mintKey({
        project_group_id: otherProjectGroupId,
        policy_ids: [policyId],
      });
      expect(otherGroupKey.status).toBe(400);
      const projectKey = await mintKey({
        project_id: projectId,
        policy_ids: [policyId],
      });
      expect(projectKey.status).toBe(400);
      const unscoped = await mintKey({ policy_ids: [policyId] });
      expect(unscoped.status).toBe(400);
      const user = await admin()
        .put(`/api/v1/users/${ownerId}/policies`)
        .send({ policy_ids: [policyId] });
      expect(user.status).toBe(400);
      const fixed = await admin()
        .patch(`/api/v1/project-groups/${projectGroupId}`)
        .send({ fixed_policy_ids: [policyId] });
      expect(fixed.status).toBe(400);
    });
  });

  describe("a project group key's policy_ids", () => {
    const projectPolicy = async (project: string) => {
      const res = await admin()
        .post('/api/v1/policies')
        .send({
          project_id: project,
          document: {
            statement: [{ effect: 'Allow', action: ['secrets:ListSecrets'] }],
          },
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    test.each([
      [
        'a project in it',
        () => {
          return projectId;
        },
      ],
      [
        'a project outside it',
        () => {
          return otherProjectId;
        },
      ],
    ])('take no policy of %s on create', async (_, project) => {
      const policyId = await projectPolicy(project());
      const res = await mintKey({
        project_group_id: projectGroupId,
        policy_ids: [policyId],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('POLICY_OUTSIDE_PROJECT');
    });

    test('take no project policy on update', async () => {
      const created = await mintKey({ project_group_id: projectGroupId });
      expect(created.status).toBe(201);
      const policyId = await projectPolicy(otherProjectId);
      const res = await authenticatedTestClient(ownerToken)
        .put(`/api/v1/api-keys/${created.body.id}`)
        .send({ policy_ids: [policyId] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('POLICY_OUTSIDE_PROJECT');
    });
  });

  describe('a key narrowed by policy_ids', () => {
    let narrowId: string;
    let key: string;

    beforeAll(async () => {
      narrowId = await groupPolicy({
        statement: [
          {
            effect: 'Allow',
            action: [
              'project-groups:GetProjectGroup',
              'project-groups:CreatePolicy',
              'project-groups:UpdatePolicy',
              'project-groups:CreateApiKey',
              'secrets:ListSecrets',
            ],
          },
        ],
      });
      const res = await mintKey({
        project_group_id: projectGroupId,
        policy_ids: [narrowId],
      });
      expect(res.status).toBe(201);
      key = res.body.key;
    });

    test('cannot widen the policy narrowing it', async () => {
      const res = await authenticatedTestClient(key)
        .put(`/api/v1/policies/${narrowId}`)
        .send({
          document: { statement: [{ effect: 'Allow', action: ['*'] }] },
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
    });

    test('writes no key under a policy outside its policy_ids', async () => {
      const created = await createGroupPolicy({
        token: key,
        document: { statement: [{ effect: 'Allow', action: ['*'] }] },
      });
      expect(created.status).toBe(201);
      const res = await mintKey(
        { project_group_id: projectGroupId, policy_ids: [created.body.id] },
        key
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_POLICY_BOUNDARY');
    });
  });
});
