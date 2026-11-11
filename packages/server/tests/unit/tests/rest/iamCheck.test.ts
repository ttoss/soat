import { flushAuditQueue } from 'src/lib/auditQueue';
import {
  parseIamRegistrationConfig,
  registerIamModules,
  unregisterIamModules,
} from 'src/lib/iamRegistrations';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const CHANNELS = {
  module: 'channels',
  resource_types: ['channel'],
  actions: [
    { action: 'channels:CreateChannel', description: 'Create a channel' },
    { action: 'channels:GetChannel', description: 'Get a channel' },
  ],
};

describe('POST /api/v1/iam/check', () => {
  let adminToken: string;
  let projectId: string;
  let otherProjectId: string;
  let noPermToken: string;

  const createPolicy = async (statement: unknown[]) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({ document: { statement } });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const mintKey = async (args: { policyIds: string[]; project?: string }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({
        name: 'Check Key',
        project_id: args.project ?? projectId,
        policy_ids: args.policyIds,
      });
    expect(res.status).toBe(201);
    return res.body.key as string;
  };

  const check = (token: string, body: Record<string, unknown>) => {
    return authenticatedTestClient(token).post('/api/v1/iam/check').send(body);
  };

  beforeAll(async () => {
    registerIamModules({
      registrations: parseIamRegistrationConfig({
        config: { modules: [CHANNELS] },
        source: 'test',
      }),
    });
    const setup = await setupProjectWithUsers({
      prefix: 'iamcheck',
      policyActions: ['*'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;
    noPermToken = setup.noPermToken!;
  });

  afterAll(() => {
    unregisterIamModules({ modules: ['channels'] });
  });

  test('a policy may name a registered action', async () => {
    await createPolicy([
      { effect: 'Allow', action: ['channels:GetChannel', 'channels:*'] },
    ]);
  });

  test('allowed is true when the caller policies allow the action', async () => {
    const policyId = await createPolicy([
      {
        effect: 'Allow',
        action: ['channels:GetChannel'],
        resource: [`srn:${projectId}:channel:ch_1`],
      },
    ]);
    const key = await mintKey({ policyIds: [policyId] });

    const res = await check(key, {
      action: 'channels:GetChannel',
      resource: `srn:${projectId}:channel:ch_1`,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true });
  });

  test('a denial is 200 with allowed false, never 403', async () => {
    const policyId = await createPolicy([
      {
        effect: 'Allow',
        action: ['channels:GetChannel'],
        resource: [`srn:${projectId}:channel:ch_1`],
      },
    ]);
    const key = await mintKey({ policyIds: [policyId] });

    const otherChannel = await check(key, {
      action: 'channels:GetChannel',
      resource: `srn:${projectId}:channel:ch_2`,
    });
    const otherAction = await check(key, {
      action: 'channels:CreateChannel',
      resource: `srn:${projectId}:channel:*`,
    });

    expect(otherChannel.status).toBe(200);
    expect(otherChannel.body).toEqual({ allowed: false });
    expect(otherAction.status).toBe(200);
    expect(otherAction.body).toEqual({ allowed: false });
  });

  test('a caller with no policies is denied', async () => {
    const res = await check(noPermToken, {
      action: 'channels:GetChannel',
      resource: `srn:${projectId}:channel:ch_1`,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: false });
  });

  test('a tag condition reads context.tags', async () => {
    const policyId = await createPolicy([
      {
        effect: 'Allow',
        action: ['channels:GetChannel'],
        condition: { StringEquals: { 'soat:ResourceTag/team': 'red' } },
      },
    ]);
    const key = await mintKey({ policyIds: [policyId] });
    const resource = `srn:${projectId}:channel:ch_1`;

    const red = await check(key, {
      action: 'channels:GetChannel',
      resource,
      context: { tags: { team: 'red' } },
    });
    const blue = await check(key, {
      action: 'channels:GetChannel',
      resource,
      context: { tags: { team: 'blue' } },
    });
    const untagged = await check(key, {
      action: 'channels:GetChannel',
      resource,
    });

    expect(red.body).toEqual({ allowed: true });
    expect(blue.body).toEqual({ allowed: false });
    expect(untagged.body).toEqual({ allowed: false });
  });

  test('a Deny wins over an Allow', async () => {
    const policyId = await createPolicy([
      { effect: 'Allow', action: ['channels:*'] },
      {
        effect: 'Deny',
        action: ['channels:GetChannel'],
        resource: [`srn:${projectId}:channel:ch_secret`],
      },
    ]);
    const key = await mintKey({ policyIds: [policyId] });

    const res = await check(key, {
      action: 'channels:GetChannel',
      resource: `srn:${projectId}:channel:ch_secret`,
    });

    expect(res.body).toEqual({ allowed: false });
  });

  test('a project-scoped key is denied in another project', async () => {
    const policyId = await createPolicy([
      { effect: 'Allow', action: ['channels:*'] },
    ]);
    const key = await mintKey({ policyIds: [policyId] });

    const own = await check(key, {
      action: 'channels:GetChannel',
      resource: `srn:${projectId}:channel:ch_1`,
    });
    const other = await check(key, {
      action: 'channels:GetChannel',
      resource: `srn:${otherProjectId}:channel:ch_1`,
    });

    expect(own.body).toEqual({ allowed: true });
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ allowed: false });
  });

  test('an admin is allowed', async () => {
    const res = await check(adminToken, {
      action: 'channels:CreateChannel',
      resource: `srn:${projectId}:channel:*`,
    });

    expect(res.body).toEqual({ allowed: true });
  });

  test('records no audit entry, since nothing was performed', async () => {
    const res = await check(adminToken, {
      action: 'channels:GetChannel',
      resource: `srn:${projectId}:channel:ch_audit`,
    });
    expect(res.status).toBe(200);

    await flushAuditQueue();
    const entries = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ action: 'channels:GetChannel' });

    expect(entries.status).toBe(200);
    expect(entries.body.data).toEqual([]);
  });

  test('returns 401 without a credential', async () => {
    const res = await testClient.post('/api/v1/iam/check').send({
      action: 'channels:GetChannel',
      resource: `srn:${projectId}:channel:ch_1`,
    });

    expect(res.status).toBe(401);
  });

  describe('returns 400', () => {
    const invalid: Array<[string, () => Record<string, unknown>]> = [
      [
        'a missing action',
        () => {
          return { resource: `srn:${projectId}:channel:ch_1` };
        },
      ],
      [
        'an action no deployment registered',
        () => {
          return {
            action: 'channels:DeleteEverything',
            resource: `srn:${projectId}:channel:ch_1`,
          };
        },
      ],
      [
        'a built-in action',
        () => {
          return {
            action: 'secrets:GetSecret',
            resource: `srn:${projectId}:secret:sec_1`,
          };
        },
      ],
      [
        'a wildcard action',
        () => {
          return {
            action: 'channels:*',
            resource: `srn:${projectId}:channel:ch_1`,
          };
        },
      ],
      [
        'a missing resource',
        () => {
          return { action: 'channels:GetChannel' };
        },
      ],
      [
        'a resource that is not an SRN',
        () => {
          return { action: 'channels:GetChannel', resource: '*' };
        },
      ],
      [
        'a wildcard project',
        () => {
          return {
            action: 'channels:GetChannel',
            resource: 'srn:*:channel:ch_1',
          };
        },
      ],
      [
        'a resource type the action module does not register',
        () => {
          return {
            action: 'channels:GetChannel',
            resource: `srn:${projectId}:secret:sec_1`,
          };
        },
      ],
      [
        'tags that are not strings',
        () => {
          return {
            action: 'channels:GetChannel',
            resource: `srn:${projectId}:channel:ch_1`,
            context: { tags: { team: 1 } },
          };
        },
      ],
      [
        'an unknown context key',
        () => {
          return {
            action: 'channels:GetChannel',
            resource: `srn:${projectId}:channel:ch_1`,
            context: { actor_id: 'act_1' },
          };
        },
      ],
    ];

    test.each(invalid)('for %s', async (_label, body) => {
      const res = await check(adminToken, body());

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
