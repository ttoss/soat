import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const PLAN = {
  statement: [
    { effect: 'Allow', action: ['*'], resource: ['*'] },
    {
      effect: 'Deny',
      action: ['groups:GetUsage', 'secrets:CreateSecret'],
      resource: ['*'],
    },
  ],
};

describe('groups', () => {
  let adminToken: string;
  let ownerToken: string;
  let ownerId: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let groupId: string;
  let planPolicyId: string;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createPolicy = async (args: {
    token?: string;
    document: unknown;
    projectId?: string;
  }) => {
    const res = await authenticatedTestClient(args.token ?? adminToken)
      .post('/api/v1/policies')
      .send({
        document: args.document,
        ...(args.projectId ? { project_id: args.projectId } : {}),
      });
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
    return type ? `srn:group:${groupId}:${type}/*` : `srn:group:${groupId}:*`;
  };

  const mintKey = async (body: Record<string, unknown>, token = ownerToken) => {
    const res = await authenticatedTestClient(token)
      .post('/api/v1/api-keys')
      .send({ name: 'group key', ...body });
    expect(res.status).toBe(201);
    return res.body as { id: string; key: string; group_id: string | null };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'groups',
      policyActions: ['secrets:*', 'iam:*', 'policies:*'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    ownerToken = setup.userToken;
    ownerId = setup.userId;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;
  });

  describe('POST /api/v1/groups', () => {
    test('401 without a credential', async () => {
      const res = await testClient.post('/api/v1/groups').send({ name: 'x' });
      expect(res.status).toBe(401);
    });

    test('403 for anyone but the admin', async () => {
      const res = await authenticatedTestClient(ownerToken)
        .post('/api/v1/groups')
        .send({ name: 'Acme', owner_id: ownerId });
      expect(res.status).toBe(403);
    });

    test('400 for an owner that is no user', async () => {
      const res = await admin()
        .post('/api/v1/groups')
        .send({ name: 'Acme', owner_id: 'user_missing' });
      expect(res.status).toBe(400);
    });

    test('the admin creates a group for its owner', async () => {
      const res = await admin()
        .post('/api/v1/groups')
        .send({ name: 'Acme', owner_id: ownerId });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Acme',
        owner_id: ownerId,
        policy_ids: [],
        fixed_policy_ids: [],
        project_ids: [],
      });
      groupId = res.body.id;
      const added = await admin().put(
        `/api/v1/groups/${groupId}/projects/${projectId}`
      );
      expect(added.status).toBe(204);
    });
  });

  describe('reading a group', () => {
    test('its owner reads it, and lists it', async () => {
      const res = await authenticatedTestClient(ownerToken).get(
        `/api/v1/groups/${groupId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.project_ids).toEqual([projectId]);
      const list =
        await authenticatedTestClient(ownerToken).get('/api/v1/groups');
      expect(list.status).toBe(200);
      expect(
        list.body.data.map((group: { id: string }) => {
          return group.id;
        })
      ).toEqual([groupId]);
    });

    test('anyone else gets 404, and an empty list', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/groups/${groupId}`
      );
      expect(res.status).toBe(404);
      const list =
        await authenticatedTestClient(noPermToken).get('/api/v1/groups');
      expect(list.body.data).toEqual([]);
    });
  });

  describe('POST /api/v1/iam/check on a group', () => {
    test('the owner holds every group action on its group', async () => {
      expect(
        await check(ownerToken, 'groups:CreateApiKey', groupSrn('api_key'))
      ).toBe(true);
      expect(
        await check(ownerToken, 'groups:GetUsage', groupSrn('usage'))
      ).toBe(true);
    });

    test('anyone else holds none', async () => {
      expect(
        await check(noPermToken, 'groups:CreateApiKey', groupSrn('api_key'))
      ).toBe(false);
    });

    test('400 for a group action off its group, or a type it is not on', async () => {
      const client = authenticatedTestClient(ownerToken);
      const offGroup = await client.post('/api/v1/iam/check').send({
        action: 'groups:CreateApiKey',
        resource: `srn:${projectId}:apiKey:*`,
      });
      expect(offGroup.status).toBe(400);
      const projectAction = await client.post('/api/v1/iam/check').send({
        action: 'secrets:ListSecrets',
        resource: groupSrn('api_key'),
      });
      expect(projectAction.status).toBe(400);
      const wrongType = await client.post('/api/v1/iam/check').send({
        action: 'groups:CreateApiKey',
        resource: groupSrn('member'),
      });
      expect(wrongType.status).toBe(400);
    });
  });

  describe('the fixed policy', () => {
    beforeAll(async () => {
      planPolicyId = await createPolicy({ document: PLAN });
      const res = await admin()
        .patch(`/api/v1/groups/${groupId}`)
        .send({ fixed_policy_ids: [planPolicyId] });
      expect(res.status).toBe(200);
      expect(res.body.fixed_policy_ids).toEqual([planPolicyId]);
    });

    test('denies a group action on the group', async () => {
      expect(
        await check(ownerToken, 'groups:GetUsage', groupSrn('usage'))
      ).toBe(false);
      expect(
        await check(ownerToken, 'groups:CreateApiKey', groupSrn('api_key'))
      ).toBe(true);
    });

    test('caps every project in the group, and none outside it', async () => {
      expect(
        await check(
          ownerToken,
          'secrets:CreateSecret',
          `srn:${projectId}:secret:*`
        )
      ).toBe(false);
      expect(
        await check(
          ownerToken,
          'secrets:CreateSecret',
          `srn:${otherProjectId}:secret:*`
        )
      ).toBe(true);
    });

    test('the owner can neither detach nor edit it', async () => {
      const detach = await authenticatedTestClient(ownerToken)
        .patch(`/api/v1/groups/${groupId}`)
        .send({ fixed_policy_ids: [] });
      expect(detach.status).toBe(403);
      const edit = await authenticatedTestClient(ownerToken)
        .put(`/api/v1/policies/${planPolicyId}`)
        .send({ document: { statement: [] } });
      expect(edit.status).toBe(403);
      const group = await admin().get(`/api/v1/groups/${groupId}`);
      expect(group.body.fixed_policy_ids).toEqual([planPolicyId]);
    });

    test('a policy a group names cannot be deleted', async () => {
      const res = await admin().delete(`/api/v1/policies/${planPolicyId}`);
      expect(res.status).toBe(409);
      expect(res.body.error.meta).toMatchObject({
        groups: 1,
        group_sample: [groupId],
      });
    });

    test('a project policy is refused as fixed', async () => {
      const scoped = await createPolicy({
        document: { statement: [{ effect: 'Allow', action: ['*'] }] },
        projectId,
      });
      const res = await admin()
        .patch(`/api/v1/groups/${groupId}`)
        .send({ fixed_policy_ids: [planPolicyId, scoped] });
      expect(res.status).toBe(400);
    });
  });

  describe("the owner's policies", () => {
    test('a deny the owner attaches denies the group action', async () => {
      const denyKeys = await createPolicy({
        token: ownerToken,
        document: {
          statement: [{ effect: 'Deny', action: ['groups:CreateApiKey'] }],
        },
        projectId,
      });
      const attached = await authenticatedTestClient(ownerToken)
        .patch(`/api/v1/groups/${groupId}`)
        .send({ policy_ids: [denyKeys] });
      expect(attached.status).toBe(200);
      expect(
        await check(ownerToken, 'groups:CreateApiKey', groupSrn('api_key'))
      ).toBe(false);
      const detached = await authenticatedTestClient(ownerToken)
        .patch(`/api/v1/groups/${groupId}`)
        .send({ policy_ids: [] });
      expect(detached.status).toBe(200);
      expect(
        await check(ownerToken, 'groups:CreateApiKey', groupSrn('api_key'))
      ).toBe(true);
    });

    test('the owner attaches no grant it does not hold', async () => {
      const wide = await createPolicy({
        document: { statement: [{ effect: 'Allow', action: ['agents:*'] }] },
      });
      const res = await authenticatedTestClient(ownerToken)
        .patch(`/api/v1/groups/${groupId}`)
        .send({ policy_ids: [wide] });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
    });

    test('a policy of a project outside the group is refused', async () => {
      const outside = await createPolicy({
        document: { statement: [{ effect: 'Deny', action: ['files:*'] }] },
        projectId: otherProjectId,
      });
      const res = await authenticatedTestClient(ownerToken)
        .patch(`/api/v1/groups/${groupId}`)
        .send({ policy_ids: [outside] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('POLICY_OUTSIDE_PROJECT');
    });
  });

  describe('group keys', () => {
    test('anyone else may not create one', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/api-keys')
        .send({ name: 'k', group_id: groupId });
      expect(res.status).toBe(403);
    });

    test('a group key acts in its group and its projects only', async () => {
      const { key, group_id: keyGroup } = await mintKey({ group_id: groupId });
      expect(keyGroup).toBe(groupId);
      expect(await check(key, 'groups:GetGroup', groupSrn())).toBe(true);
      expect(
        await check(key, 'secrets:ListSecrets', `srn:${projectId}:secret:*`)
      ).toBe(true);
      expect(
        await check(
          key,
          'secrets:ListSecrets',
          `srn:${otherProjectId}:secret:*`
        )
      ).toBe(false);
    });

    test('narrowed by policy_ids, it cannot reach a group action they deny', async () => {
      const narrow = await createPolicy({
        document: {
          statement: [
            { effect: 'Allow', action: ['groups:GetGroup', 'iam:*'] },
          ],
        },
      });
      const { key } = await mintKey({
        group_id: groupId,
        policy_ids: [narrow],
      });
      expect(await check(key, 'groups:GetGroup', groupSrn())).toBe(true);
      expect(await check(key, 'groups:CreateApiKey', groupSrn('api_key'))).toBe(
        false
      );
      const res = await authenticatedTestClient(key)
        .post('/api/v1/api-keys')
        .send({ name: 'k', group_id: groupId });
      expect(res.status).toBe(403);
    });

    test('it manages no key outside its group', async () => {
      const { key } = await mintKey({ group_id: groupId });
      const unscoped = await authenticatedTestClient(key)
        .post('/api/v1/api-keys')
        .send({ name: 'escape' });
      expect(unscoped.status).toBe(403);
      const outside = await authenticatedTestClient(key)
        .post('/api/v1/api-keys')
        .send({ name: 'escape', project_id: otherProjectId });
      expect(outside.status).toBe(403);
      const inside = await authenticatedTestClient(key)
        .post('/api/v1/api-keys')
        .send({ name: 'inside', project_id: projectId });
      expect(inside.status).toBe(201);
      const list = await authenticatedTestClient(key).get('/api/v1/api-keys');
      expect(list.status).toBe(200);
      for (const listed of list.body.data) {
        expect(
          listed.group_id === groupId || listed.project_id === projectId
        ).toBe(true);
      }
    });

    test('a token minted from it still acts in one project', async () => {
      const { key } = await mintKey({ group_id: groupId });
      const mint = (body: Record<string, unknown>) => {
        return authenticatedTestClient(key)
          .post('/api/v1/iam/tokens')
          .send({
            policy: { statement: [{ effect: 'Allow', action: ['*'] }] },
            ...body,
          });
      };
      expect((await mint({})).status).toBe(403);
      expect((await mint({ project_id: otherProjectId })).status).toBe(403);
      const minted = await mint({ project_id: projectId });
      expect(minted.status).toBe(201);
      const token = minted.body.token as string;
      expect(
        await check(token, 'secrets:ListSecrets', `srn:${projectId}:secret:*`)
      ).toBe(true);
      expect(await check(token, 'groups:GetGroup', groupSrn())).toBe(false);
    });

    test('its owner revokes it', async () => {
      const { id } = await mintKey({ group_id: groupId });
      const res = await authenticatedTestClient(ownerToken).delete(
        `/api/v1/api-keys/${id}`
      );
      expect(res.status).toBe(204);
    });
  });

  describe('projects of a group', () => {
    test('the owner creates a project in its group', async () => {
      const res = await authenticatedTestClient(ownerToken)
        .post(`/api/v1/groups/${groupId}/projects`)
        .send({ name: 'In group' });
      expect(res.status).toBe(201);
      const group = await admin().get(`/api/v1/groups/${groupId}`);
      expect(group.body.project_ids).toContain(res.body.id);
    });

    test('anyone else gets 404', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/groups/${groupId}/projects`)
        .send({ name: 'Nope' });
      expect(res.status).toBe(404);
    });

    test('only the admin moves a project in or out', async () => {
      const res = await authenticatedTestClient(ownerToken).put(
        `/api/v1/groups/${groupId}/projects/${otherProjectId}`
      );
      expect(res.status).toBe(403);
    });

    test('a group holding projects is not deleted', async () => {
      const refused = await admin().delete(`/api/v1/groups/${groupId}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('GROUP_HAS_PROJECTS');
      const group = await admin().get(`/api/v1/groups/${groupId}`);
      for (const project of group.body.project_ids as string[]) {
        const removed = await admin().delete(
          `/api/v1/groups/${groupId}/projects/${project}`
        );
        expect(removed.status).toBe(204);
      }
      const deleted = await admin().delete(`/api/v1/groups/${groupId}`);
      expect(deleted.status).toBe(204);
    });
  });
});
