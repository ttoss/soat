import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('OAuth clients', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let secretRef: string;

  const clientBody = (overrides: Record<string, unknown> = {}) => {
    return {
      project_id: projectId,
      name: 'x',
      authorize_url: 'https://x.com/i/oauth2/authorize',
      token_url: 'https://api.x.com/2/oauth2/token',
      revocation_url: 'https://api.x.com/2/oauth2/revoke',
      client_id: 'x-client-id',
      client_secret: secretRef,
      scopes: ['tweet.read', 'users.read', 'offline.access'],
      ...overrides,
    };
  };

  const createClient = async (overrides: Record<string, unknown> = {}) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/oauth-clients')
      .send(clientBody(overrides));
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'oauthclients',
      policyActions: [
        'oauth-clients:*',
        'secrets:CreateSecret',
        'secrets:UseSecret',
      ],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    const secret = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'x-secret', value: 'shh' });
    expect(secret.status).toBe(201);
    secretRef = `{{secret:${secret.body.id}}}`;
  });

  describe('POST /api/v1/oauth-clients', () => {
    test('creates a client with defaults and echoes the secret reference', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/oauth-clients')
        .send(clientBody());

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^oauc_/);
      expect(res.body).toMatchObject({
        project_id: projectId,
        name: 'x',
        client_id: 'x-client-id',
        client_secret: secretRef,
        scopes: ['tweet.read', 'users.read', 'offline.access'],
        pkce: true,
        token_endpoint_auth_method: 'client_secret_basic',
        redirect_uri: null,
        authorize_params: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('shh');
    });

    test('a literal client_secret is refused', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/oauth-clients')
        .send(clientBody({ client_secret: 'plain-text' }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a non-http authorize_url is refused', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/oauth-clients')
        .send(clientBody({ authorize_url: 'javascript:alert(1)' }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a client_secret the caller may not use is 403', async () => {
      const creatorToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'oauthclientsnosecret',
        actions: ['oauth-clients:CreateOauthClient'],
      });
      const res = await authenticatedTestClient(creatorToken)
        .post('/api/v1/oauth-clients')
        .send(clientBody());

      expect(res.status).toBe(403);
      expect(res.body.error.meta.action).toBe('secrets:UseSecret');
    });

    test('unauthenticated is 401', async () => {
      const res = await testClient
        .post('/api/v1/oauth-clients')
        .send(clientBody());
      expect(res.status).toBe(401);
    });

    test('another project is 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/oauth-clients')
        .send(clientBody({ project_id: otherProjectId }));
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/oauth-clients', () => {
    test('lists the project clients', async () => {
      const id = await createClient({ name: 'listed' });
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/oauth-clients')
        .query({ project_id: projectId });

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((row: { id: string }) => {
          return row.id;
        })
      ).toContain(id);
    });

    test('an admin without project_id lists every project', async () => {
      const id = await createClient({ name: 'admin-listed' });
      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/oauth-clients')
        .query({ limit: 100 });
      expect(res.status).toBe(200);
      expect(
        res.body.data.map((row: { id: string }) => {
          return row.id;
        })
      ).toContain(id);
    });

    test('unauthenticated is 401', async () => {
      const res = await testClient.get('/api/v1/oauth-clients');
      expect(res.status).toBe(401);
    });

    test('another project is 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .get('/api/v1/oauth-clients')
        .query({ project_id: otherProjectId });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/oauth-clients/:oauth_client_id', () => {
    test('reads one client', async () => {
      const id = await createClient();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/oauth-clients/${id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
    });

    test('an unknown id is 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/oauth-clients/oauc_missing'
      );
      expect(res.status).toBe(404);
    });

    test('without permission is hidden as 404', async () => {
      const id = await createClient();
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/oauth-clients/${id}`
      );
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/oauth-clients/:oauth_client_id', () => {
    test('updates fields and clears a nullable one', async () => {
      const id = await createClient();
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/oauth-clients/${id}`)
        .send({
          scopes: ['users.read'],
          revocation_url: null,
          authorize_params: { prompt: 'consent' },
          token_endpoint_auth_method: 'client_secret_post',
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        scopes: ['users.read'],
        revocation_url: null,
        authorize_params: { prompt: 'consent' },
        token_endpoint_auth_method: 'client_secret_post',
      });
    });

    test('without project access is hidden as 404', async () => {
      const id = await createClient();
      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/oauth-clients/${id}`)
        .send({ name: 'renamed' });
      expect(res.status).toBe(404);
    });
  });

  describe('writes by a reader', () => {
    test('PATCH and DELETE are 403', async () => {
      const id = await createClient();
      const readerToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'oauthclientsreader',
        actions: ['oauth-clients:GetOauthClient'],
      });

      const patch = await authenticatedTestClient(readerToken)
        .patch(`/api/v1/oauth-clients/${id}`)
        .send({ name: 'renamed' });
      const remove = await authenticatedTestClient(readerToken).delete(
        `/api/v1/oauth-clients/${id}`
      );

      expect(patch.status).toBe(403);
      expect(remove.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/oauth-clients/:oauth_client_id', () => {
    test('deletes the client', async () => {
      const id = await createClient();
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/oauth-clients/${id}`
      );
      expect(res.status).toBe(204);

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/oauth-clients/${id}`
      );
      expect(read.status).toBe(404);
    });

    test('without project access is hidden as 404', async () => {
      const id = await createClient();
      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/oauth-clients/${id}`
      );
      expect(res.status).toBe(404);
    });
  });
});
