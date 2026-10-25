import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A key carrying `policy_ids` is a credential narrowed to a capability set.
 * The narrowing holds only if the key cannot write a key wider than itself:
 * `POST /api-keys` hands back a raw key, and `PUT /api-keys/{id}` rewrites the
 * boundary of a key the caller may already hold.
 */
describe('API key policy boundary', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let readPolicyId: string;
  let otherPolicyId: string;

  const mintKey = async (args: { token: string; policyIds?: string[] }) => {
    const res = await authenticatedTestClient(args.token)
      .post('/api/v1/api-keys')
      .send({
        name: 'Boundary Key',
        project_id: projectId,
        ...(args.policyIds ? { policy_ids: args.policyIds } : {}),
      });
    expect(res.status).toBe(201);
    return res.body as { id: string; key: string; policy_ids: string[] };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'akbound',
      policyActions: ['*'],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const readPolicy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['secrets:ListSecrets'] }],
        },
      });
    readPolicyId = readPolicy.body.id;

    const otherPolicy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      });
    otherPolicyId = otherPolicy.body.id;
  });

  describe('a narrowed key', () => {
    test('is allowed an action inside its capability set', async () => {
      const narrowed = await mintKey({
        token: userToken,
        policyIds: [readPolicyId],
      });

      const res = await authenticatedTestClient(narrowed.key).get(
        `/api/v1/secrets?project_id=${projectId}`
      );

      expect(res.status).toBe(200);
    });

    test('is refused an action outside its capability set with 403', async () => {
      const narrowed = await mintKey({
        token: userToken,
        policyIds: [readPolicyId],
      });

      const res = await authenticatedTestClient(narrowed.key)
        .post('/api/v1/secrets')
        .send({ project_id: projectId, name: 'nope', value: 'x' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('POST /api/v1/api-keys', () => {
    test('omitting policy_ids mints a key carrying the caller boundary', async () => {
      const narrowed = await mintKey({
        token: userToken,
        policyIds: [readPolicyId],
      });

      const minted = await mintKey({ token: narrowed.key });

      expect(minted.id).toBeDefined();
      expect(minted.policy_ids).toEqual([readPolicyId]);
    });

    test('a subset of the caller policies is accepted', async () => {
      const narrowed = await mintKey({
        token: userToken,
        policyIds: [readPolicyId, otherPolicyId],
      });

      const minted = await mintKey({
        token: narrowed.key,
        policyIds: [otherPolicyId],
      });

      expect(minted.policy_ids).toEqual([otherPolicyId]);
    });

    test('a policy outside the caller boundary returns 403', async () => {
      const narrowed = await mintKey({
        token: userToken,
        policyIds: [readPolicyId],
      });

      const res = await authenticatedTestClient(narrowed.key)
        .post('/api/v1/api-keys')
        .send({ name: 'Wider', policy_ids: [otherPolicyId] });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_POLICY_BOUNDARY');
      expect(res.body.error.meta).toEqual({
        boundary_policy_ids: [readPolicyId],
        requested_policy_ids: [otherPolicyId],
      });
    });

    test('an empty policy_ids returns 403', async () => {
      const narrowed = await mintKey({
        token: userToken,
        policyIds: [readPolicyId],
      });

      const res = await authenticatedTestClient(narrowed.key)
        .post('/api/v1/api-keys')
        .send({ name: 'Unbounded', policy_ids: [] });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_POLICY_BOUNDARY');
    });

    test('a key with no boundary is unaffected', async () => {
      const plain = await mintKey({ token: userToken });

      const minted = await mintKey({
        token: plain.key,
        policyIds: [otherPolicyId],
      });

      expect(minted.policy_ids).toEqual([otherPolicyId]);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await authenticatedTestClient('sk_invalid')
        .post('/api/v1/api-keys')
        .send({ name: 'x' });

      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/v1/api-keys/:api_key_id', () => {
    test('clearing its own policy_ids returns 403', async () => {
      const narrowed = await mintKey({
        token: userToken,
        policyIds: [readPolicyId],
      });

      const res = await authenticatedTestClient(narrowed.key)
        .put(`/api/v1/api-keys/${narrowed.id}`)
        .send({ policy_ids: [] });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_POLICY_BOUNDARY');
    });

    test('widening another key returns 403', async () => {
      const narrowed = await mintKey({
        token: userToken,
        policyIds: [readPolicyId],
      });
      const target = await mintKey({
        token: userToken,
        policyIds: [readPolicyId],
      });

      const res = await authenticatedTestClient(narrowed.key)
        .put(`/api/v1/api-keys/${target.id}`)
        .send({ policy_ids: [otherPolicyId] });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_POLICY_BOUNDARY');
    });

    test('renaming leaves the boundary unchecked', async () => {
      const narrowed = await mintKey({
        token: userToken,
        policyIds: [readPolicyId],
      });

      const res = await authenticatedTestClient(narrowed.key)
        .put(`/api/v1/api-keys/${narrowed.id}`)
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(res.body.policy_ids).toEqual([readPolicyId]);
    });

    test('narrowing within the boundary is accepted', async () => {
      const narrowed = await mintKey({
        token: userToken,
        policyIds: [readPolicyId, otherPolicyId],
      });

      const res = await authenticatedTestClient(narrowed.key)
        .put(`/api/v1/api-keys/${narrowed.id}`)
        .send({ policy_ids: [readPolicyId] });

      expect(res.status).toBe(200);
      expect(res.body.policy_ids).toEqual([readPolicyId]);
    });
  });
});
