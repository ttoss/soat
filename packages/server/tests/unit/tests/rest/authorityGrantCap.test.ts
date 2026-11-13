import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A request's authority is its grant ∩ its caps. An absent grant allows
 * nothing, an absent cap narrows nothing, and `admin` is an unrestricted grant
 * that a key's project or `policy_ids` caps like any other.
 */
describe('authority: grant ∩ caps', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let filesOnlyPolicyId: string;
  let userKeyId: string;
  let adminPinnedKey: string;
  let adminCappedKey: string;
  let userUncappedKey: string;
  let userCappedKey: string;

  const mintKey = async (args: {
    token: string;
    body: Record<string, unknown>;
  }): Promise<{ id: string; key: string }> => {
    const res = await authenticatedTestClient(args.token)
      .post('/api/v1/api-keys')
      .send({ name: 'grant-cap key', ...args.body });
    expect(res.status).toBe(201);
    return { id: res.body.id, key: res.body.key };
  };

  const consent = (token: string, project: string) => {
    return authenticatedTestClient(token)
      .post('/api/v1/oauth/consent')
      .send({
        project_id: project,
        selection: { kind: 'modules', modules: ['agents'] },
      });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'grantcap',
      policyActions: ['*'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    const policy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: { statement: [{ effect: 'Allow', action: ['files:*'] }] },
      });
    filesOnlyPolicyId = policy.body.id;

    userKeyId = (
      await mintKey({ token: userToken, body: { project_id: projectId } })
    ).id;
    adminPinnedKey = (
      await mintKey({ token: adminToken, body: { project_id: projectId } })
    ).key;
    adminCappedKey = (
      await mintKey({
        token: adminToken,
        body: { policy_ids: [filesOnlyPolicyId] },
      })
    ).key;
    userUncappedKey = (await mintKey({ token: userToken, body: {} })).key;
    userCappedKey = (
      await mintKey({
        token: userToken,
        body: { policy_ids: [filesOnlyPolicyId] },
      })
    ).key;
  });

  describe('an absent grant allows nothing', () => {
    test('a user holding no policy lists no project', async () => {
      const res =
        await authenticatedTestClient(noPermToken).get('/api/v1/projects');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    test('a user holding no policy reads no project', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/projects/${projectId}`
      );

      expect(res.status).toBe(403);
    });
  });

  describe('an absent cap narrows nothing', () => {
    test("a key with no policy_ids holds its owner's grant", async () => {
      const res = await authenticatedTestClient(userUncappedKey).get(
        `/api/v1/projects/${otherProjectId}`
      );

      expect(res.status).toBe(200);
    });

    test("a key's policy_ids cap its owner's grant", async () => {
      const res = await authenticatedTestClient(userCappedKey).get(
        `/api/v1/projects/${otherProjectId}`
      );

      expect(res.status).toBe(403);
    });
  });

  describe("an admin's key pinned to a project", () => {
    test('reads no other project', async () => {
      const res = await authenticatedTestClient(adminPinnedKey).get(
        `/api/v1/projects/${otherProjectId}`
      );

      expect(res.status).toBe(403);
    });

    test('lists only its project', async () => {
      const res =
        await authenticatedTestClient(adminPinnedKey).get('/api/v1/projects');

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((project: { id: string }) => {
          return project.id;
        })
      ).toEqual([projectId]);
    });

    test("reads no other user's API key", async () => {
      const res = await authenticatedTestClient(adminPinnedKey).get(
        `/api/v1/api-keys/${userKeyId}`
      );

      expect(res.status).toBe(403);
    });

    test('consents for no other project', async () => {
      const res = await consent(adminPinnedKey, otherProjectId);

      expect(res.status).toBe(403);
    });
  });

  describe("an admin's key narrowed by policy_ids", () => {
    test('reads no project its policies do not allow', async () => {
      const res = await authenticatedTestClient(adminCappedKey).get(
        `/api/v1/projects/${projectId}`
      );

      expect(res.status).toBe(403);
    });

    test('lists no project its policies do not allow', async () => {
      const res =
        await authenticatedTestClient(adminCappedKey).get('/api/v1/projects');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    test("lists no other user's API key", async () => {
      const res =
        await authenticatedTestClient(adminCappedKey).get('/api/v1/api-keys');

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((key: { id: string }) => {
          return key.id;
        })
      ).not.toContain(userKeyId);
    });
  });

  describe('POST /api/v1/oauth/consent', () => {
    test('an unnarrowed credential consents', async () => {
      const res = await consent(userToken, projectId);

      expect(res.status).toBe(200);
    });

    test('a key narrowed by policy_ids consents to nothing wider', async () => {
      const res = await consent(userCappedKey, projectId);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CREDENTIAL_NARROWED');
    });

    test('is 401 without a credential', async () => {
      const res = await testClient
        .post('/api/v1/oauth/consent')
        .send({ project_id: projectId });

      expect(res.status).toBe(401);
    });
  });

  test("an unrestricted admin lists every user's API keys", async () => {
    const token = await loginAs('grantcapadmin', 'supersecret');
    const res = await authenticatedTestClient(token).get('/api/v1/api-keys');

    expect(res.status).toBe(200);
    expect(
      res.body.data.map((key: { id: string }) => {
        return key.id;
      })
    ).toContain(userKeyId);
  });
});
