import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

let adminToken: string;
let projectId: string;
let projectKey: string;
let seq = 0;

const unique = (base: string): string => {
  seq += 1;
  return `${base}-${seq}`;
};

const createProjectKey = async (args: { deny?: string[] }) => {
  const policyRes = await authenticatedTestClient(adminToken)
    .post('/api/v1/policies')
    .send({
      document: {
        statement: [
          {
            effect: 'Allow',
            action: ['*'],
            resource: [`srn:${projectId}:*:*`],
          },
          ...(args.deny
            ? [
                {
                  effect: 'Deny',
                  action: args.deny,
                  resource: [`srn:${projectId}:*:*`],
                },
              ]
            : []),
        ],
      },
    });
  const keyRes = await authenticatedTestClient(adminToken)
    .post('/api/v1/api-keys')
    .send({
      name: unique('fmoauth-key'),
      project_id: projectId,
      policy_ids: [policyRes.body.id],
    });
  expect(keyRes.status).toBe(201);
  return keyRes.body.key as string;
};

const clientProperties = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => {
  return {
    name: 'x',
    authorize_url: 'https://x.com/i/oauth2/authorize',
    token_url: 'https://api.x.com/2/oauth2/token',
    client_id: 'x-client-id',
    client_secret: { sub: '{{secret:${XSecret}}}' },
    scopes: ['tweet.read', 'users.read'],
    ...overrides,
  };
};

const stackTemplate = (args: {
  client?: Record<string, unknown>;
  clientRef?: string;
}) => {
  return {
    resources: {
      XSecret: {
        type: 'secret',
        properties: { name: 'x-client-secret', value: 'shh-client-secret' },
      },
      XClient: {
        type: 'oauth_client',
        properties: clientProperties(args.client),
      },
      XProfile: {
        type: 'tool',
        properties: {
          name: 'x-profile',
          type: 'http',
          execute: {
            url: 'https://api.x.com/2/users/me',
            auth: {
              type: 'oauth_connection',
              oauth_client_id: { ref: args.clientRef ?? 'XClient' },
            },
          },
        },
      },
    },
  };
};

const physicalId = (
  formation: {
    resources: { logical_id: string; physical_resource_id: string }[];
  },
  logicalId: string
): string => {
  const found = formation.resources.find((resource) => {
    return resource.logical_id === logicalId;
  });
  if (!found) throw new Error(`no resource ${logicalId}`);
  return found.physical_resource_id;
};

const deploy = async (template: unknown, token: string = projectKey) => {
  return authenticatedTestClient(token)
    .post('/api/v1/formations')
    .send({ project_id: projectId, name: unique('oauth-stack'), template });
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'fmoauthclient',
    policyActions: ['formations:GetFormation'],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;
  projectKey = await createProjectKey({});
});

describe('oauth_client formation resource', () => {
  test('a project key applies secret + oauth_client + tool, the tool naming the client by ref', async () => {
    const res = await deploy(stackTemplate({}));

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');

    const clientId = physicalId(res.body, 'XClient');
    const client = await authenticatedTestClient(projectKey).get(
      `/api/v1/oauth-clients/${clientId}`
    );
    expect(client.status).toBe(200);
    expect(client.body).toMatchObject({
      id: clientId,
      name: 'x',
      client_id: 'x-client-id',
      client_secret: `{{secret:${physicalId(res.body, 'XSecret')}}}`,
      scopes: ['tweet.read', 'users.read'],
      redirect_uri: null,
    });

    const tool = await authenticatedTestClient(projectKey).get(
      `/api/v1/tools/${physicalId(res.body, 'XProfile')}`
    );
    expect(tool.body.execute.auth).toEqual({
      type: 'oauth_connection',
      oauth_client_id: clientId,
    });
  });

  test('the formation never echoes the client secret value', async () => {
    const res = await deploy(stackTemplate({}));
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('shh-client-secret');

    const read = await authenticatedTestClient(projectKey).get(
      `/api/v1/formations/${res.body.id}`
    );
    expect(JSON.stringify(read.body)).not.toContain('shh-client-secret');
  });

  test('an update changes the client in place and plans as a no-op after', async () => {
    const created = await deploy(stackTemplate({}));
    const clientId = physicalId(created.body, 'XClient');

    const template = stackTemplate({
      client: {
        scopes: ['tweet.read'],
        redirect_uri: 'https://app.example.com/cb',
      },
    });
    const updated = await authenticatedTestClient(projectKey)
      .put(`/api/v1/formations/${created.body.id}`)
      .send({ template });
    expect(updated.status).toBe(200);
    expect(physicalId(updated.body, 'XClient')).toBe(clientId);

    const client = await authenticatedTestClient(projectKey).get(
      `/api/v1/oauth-clients/${clientId}`
    );
    expect(client.body.scopes).toEqual(['tweet.read']);
    expect(client.body.redirect_uri).toBe('https://app.example.com/cb');

    const plan = await authenticatedTestClient(projectKey)
      .post('/api/v1/formations/plan')
      .send({ project_id: projectId, formation_id: created.body.id, template });
    expect(plan.status).toBe(200);
    const change = plan.body.changes.find((entry: { logical_id: string }) => {
      return entry.logical_id === 'XClient';
    });
    expect(change.action).toBe('no-op');
  });

  test('deleting the formation removes the client', async () => {
    const created = await deploy(stackTemplate({}));
    const clientId = physicalId(created.body, 'XClient');

    const deleted = await authenticatedTestClient(projectKey).delete(
      `/api/v1/formations/${created.body.id}`
    );
    expect(deleted.status).toBe(200);

    const client = await authenticatedTestClient(projectKey).get(
      `/api/v1/oauth-clients/${clientId}`
    );
    expect(client.status).toBe(404);
  });

  test('a ref to a missing logical id fails plan', async () => {
    const res = await authenticatedTestClient(projectKey)
      .post('/api/v1/formations/plan')
      .send({
        project_id: projectId,
        template: stackTemplate({ clientRef: 'MissingClient' }),
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(
      "Referenced resource 'MissingClient' does not exist in template"
    );
  });

  test('a literal client_secret is refused at validation', async () => {
    const res = await authenticatedTestClient(projectKey)
      .post('/api/v1/formations/validate')
      .send({
        template: stackTemplate({ client: { client_secret: 'plain-value' } }),
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toContainEqual({
      path: 'resources.XClient.properties.client_secret',
      message:
        'client_secret must be a secret reference ({{secret:sec_...}}), never the value.',
    });
  });

  test('a public client without client_secret applies', async () => {
    const template = stackTemplate({});
    const { client_secret: _secret, ...publicClient } = clientProperties({
      pkce: true,
    });
    void _secret;
    template.resources.XClient.properties = publicClient;

    const res = await deploy(template);
    expect(res.status).toBe(201);
    const client = await authenticatedTestClient(projectKey).get(
      `/api/v1/oauth-clients/${physicalId(res.body, 'XClient')}`
    );
    expect(client.body.client_secret).toBeNull();
  });

  test('a key without oauth-clients:CreateOauthClient is refused before anything applies', async () => {
    const key = await createProjectKey({
      deny: ['oauth-clients:CreateOauthClient'],
    });
    const res = await deploy(stackTemplate({}), key);

    expect(res.status).toBe(403);
    expect(res.body.error.meta.denied_actions).toContainEqual({
      logical_id: 'XClient',
      resource_type: 'oauth_client',
      action: 'oauth-clients:CreateOauthClient',
    });
  });
});
