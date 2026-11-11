import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

let adminToken: string;
let projectId: string;

const templateWith = (oauthClientId: unknown) => {
  return {
    parameters: { XOauthClientId: { type: 'string', default: 'oauc_default' } },
    resources: {
      ProfileTool: {
        type: 'tool',
        properties: {
          name: 'formation-oauth-param-tool',
          type: 'http',
          execute: {
            url: 'https://api.example.com/me',
            auth: {
              type: 'oauth_connection',
              oauth_client_id: oauthClientId,
            },
          },
        },
      },
    },
  };
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'fmauthexpr',
    policyActions: ['formations:GetFormation'],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;
});

describe('POST /api/v1/formations/validate', () => {
  test.each([
    ['param', { param: 'XOauthClientId' }],
    ['sub', { sub: '${XOauthClientId}' }],
  ])(
    'accepts execute.auth.oauth_client_id written as a %s',
    async (_kind, oauthClientId) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/validate')
        .send({ template: templateWith(oauthClientId) });

      expect(res.status).toBe(200);
      expect(res.body.errors).toEqual([]);
      expect(res.body.valid).toBe(true);
    }
  );

  test('still rejects a missing execute.auth.oauth_client_id', async () => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/formations/validate')
      .send({ template: templateWith(undefined) });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual([
      {
        path: 'resources.ProfileTool.properties.execute',
        message:
          'execute.auth.oauth_client_id is required and must be a non-empty string.',
      },
    ]);
  });
});

describe('POST /api/v1/formations', () => {
  test('deploys execute.auth.oauth_client_id resolved from a parameter', async () => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'oauth-client-param',
        template: templateWith({ param: 'XOauthClientId' }),
        parameters: { XOauthClientId: 'oauc_fromparameter' },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');

    const tool = await authenticatedTestClient(adminToken).get(
      `/api/v1/tools/${res.body.resources[0].physical_resource_id}`
    );
    expect(tool.status).toBe(200);
    expect(tool.body.execute.auth).toEqual({
      type: 'oauth_connection',
      oauth_client_id: 'oauc_fromparameter',
    });
  });
});
