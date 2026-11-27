import {
  parseIamRegistrationConfig,
  registerIamModules,
  unregisterIamModules,
} from 'src/lib/iamRegistrations';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const BILLING = {
  module: 'billing',
  project_group_actions: [
    { action: 'billing:TopUp', resource_types: ['top_up'] },
    { action: 'billing:GetPlan', resource_types: ['*'] },
  ],
};

const CHANNELS = {
  module: 'channels',
  resource_types: ['channel'],
  actions: [{ action: 'channels:GetChannel' }],
};

describe('project group actions a deployment registers', () => {
  let adminToken: string;
  let ownerToken: string;
  let noPermToken: string;
  let projectId: string;
  let projectGroupId: string;

  const createPolicy = (args: {
    token?: string;
    statement: unknown[];
    projectId?: string;
  }) => {
    return authenticatedTestClient(args.token ?? adminToken)
      .post('/api/v1/policies')
      .send({
        document: { statement: args.statement },
        ...(args.projectId ? { project_id: args.projectId } : {}),
      });
  };

  const check = (token: string, action: string, resource: string) => {
    return authenticatedTestClient(token)
      .post('/api/v1/iam/check')
      .send({ action, resource });
  };

  const allowed = async (token: string, action: string, resource: string) => {
    const res = await check(token, action, resource);
    expect(res.status).toBe(200);
    return res.body.allowed as boolean;
  };

  const groupSrn = (type?: string) => {
    return type
      ? `srn:project-group:${projectGroupId}:${type}/*`
      : `srn:project-group:${projectGroupId}:*`;
  };

  beforeAll(async () => {
    registerIamModules({
      registrations: parseIamRegistrationConfig({
        config: { modules: [BILLING, CHANNELS] },
        source: 'test',
      }),
    });
    const setup = await setupProjectWithUsers({
      prefix: 'pgregistered',
      policyActions: ['iam:*', 'policies:*'],
    });
    adminToken = setup.adminToken;
    ownerToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    const group = await authenticatedTestClient(adminToken)
      .post('/api/v1/project-groups')
      .send({ name: 'Billing', owner_id: setup.userId });
    expect(group.status).toBe(201);
    projectGroupId = group.body.id;
    const added = await authenticatedTestClient(adminToken).put(
      `/api/v1/project-groups/${projectGroupId}/projects/${projectId}`
    );
    expect(added.status).toBe(204);
  });

  afterAll(() => {
    unregisterIamModules({ modules: ['billing', 'channels'] });
  });

  describe('in a policy document', () => {
    test('a global or project policy may name them', async () => {
      const global = await createPolicy({
        statement: [
          { effect: 'Allow', action: ['billing:TopUp', 'billing:*'] },
        ],
      });
      expect(global.status).toBe(201);
      const project = await createPolicy({
        statement: [{ effect: 'Deny', action: ['billing:GetPlan'] }],
        projectId,
      });
      expect(project.status).toBe(201);
    });

    test('an action the module did not register is refused', async () => {
      const res = await createPolicy({
        statement: [{ effect: 'Allow', action: ['billing:Refund'] }],
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('billing:Refund');
    });
  });

  describe('POST /api/v1/iam/check', () => {
    test('the owner holds them on its project group', async () => {
      expect(
        await allowed(ownerToken, 'billing:TopUp', groupSrn('top_up'))
      ).toBe(true);
      expect(await allowed(ownerToken, 'billing:GetPlan', groupSrn())).toBe(
        true
      );
    });

    test('anyone else holds none', async () => {
      expect(
        await allowed(noPermToken, 'billing:TopUp', groupSrn('top_up'))
      ).toBe(false);
    });

    test('the owner holds none on another project group', async () => {
      expect(
        await allowed(
          ownerToken,
          'billing:TopUp',
          'srn:project-group:pgrp_other:top_up/*'
        )
      ).toBe(false);
    });

    test('a deny the project group attaches denies them', async () => {
      const cap = await createPolicy({
        statement: [
          { effect: 'Allow', action: ['*'], resource: ['*'] },
          { effect: 'Deny', action: ['billing:TopUp'], resource: ['*'] },
        ],
      });
      expect(cap.status).toBe(201);
      const attach = (fixedPolicyIds: string[]) => {
        return authenticatedTestClient(adminToken)
          .patch(`/api/v1/project-groups/${projectGroupId}`)
          .send({ fixed_policy_ids: fixedPolicyIds });
      };
      expect((await attach([cap.body.id])).status).toBe(200);
      try {
        expect(
          await allowed(ownerToken, 'billing:TopUp', groupSrn('top_up'))
        ).toBe(false);
        expect(await allowed(ownerToken, 'billing:GetPlan', groupSrn())).toBe(
          true
        );
      } finally {
        expect((await attach([])).status).toBe(200);
      }
    });

    test('a project group key narrowed by policy_ids reaches only what they allow', async () => {
      const narrow = await createPolicy({
        statement: [{ effect: 'Allow', action: ['billing:GetPlan'] }],
      });
      expect(narrow.status).toBe(201);
      const key = await authenticatedTestClient(ownerToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'billing key',
          project_group_id: projectGroupId,
          policy_ids: [narrow.body.id],
        });
      expect(key.status).toBe(201);
      expect(await allowed(key.body.key, 'billing:GetPlan', groupSrn())).toBe(
        true
      );
      expect(
        await allowed(key.body.key, 'billing:TopUp', groupSrn('top_up'))
      ).toBe(false);
    });

    test('a key pinned to a project holds none', async () => {
      const key = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ name: 'project key', project_id: projectId });
      expect(key.status).toBe(201);
      expect(
        await allowed(key.body.key, 'billing:TopUp', groupSrn('top_up'))
      ).toBe(false);
    });

    test.each<[string, string, () => string]>([
      [
        'on a project SRN',
        'billing:TopUp',
        () => {
          return `srn:${projectId}:top_up:*`;
        },
      ],
      [
        'on a type it is not checked on',
        'billing:TopUp',
        () => {
          return groupSrn();
        },
      ],
      [
        'a registered project action on a project group SRN',
        'channels:GetChannel',
        () => {
          return groupSrn('channel');
        },
      ],
      [
        'an unregistered action',
        'billing:Refund',
        () => {
          return groupSrn('top_up');
        },
      ],
    ])('400 for a registered action %s', async (_label, action, resource) => {
      const res = await check(ownerToken, action, resource());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
