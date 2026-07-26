import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Resource-tag authorization driven through REST.
 *
 * Every other `soat:ResourceTag/*` test in the suite is a `lib/` test
 * (`policyCompiler`, `fileAuthorization`, `conversationHelpers`) that calls the
 * evaluator with hand-built inputs, so none of them crosses the `caseTransform`
 * middleware — and every one uses a single-word tag (`env`, `team`), the one key
 * shape the transform leaves alone. That combination hid a real defect: a
 * multi-word tag key was rewritten on the way in, so what a caller wrote
 * (`cost_center`) was not what the tags column stored (`costCenter`), two
 * distinct tags collapsed into one, and `Environment` came back as
 * `_environment`.
 */
describe('Resource tag policies (end-to-end)', () => {
  let adminToken: string;
  let userId: string;
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'tagpoladmin', password: 'supersecret' });

    adminToken = await loginAs('tagpoladmin', 'supersecret');

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'tagpoluser', password: 'tagpolpass' });
    userId = userRes.body.id;
    userToken = await loginAs('tagpoluser', 'tagpolpass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Tag Policy Project' });
    projectId = projectRes.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: userId });
  });

  test('a multi-word tag key is stored and returned exactly as written', async () => {
    const tags = {
      cost_center: 'platform',
      costCenter: 'a-different-tag',
      Environment: 'prod',
      'team.name': 'core',
    };

    const created = await authenticatedTestClient(adminToken)
      .post('/api/v1/documents')
      .send({ project_id: projectId, content: 'tagged', tags });

    expect(created.status).toBe(201);
    // All four survive: `cost_center` and `costCenter` are different tags and
    // must not collapse into one, and `Environment` must not become
    // `_environment`.
    expect(created.body.tags).toEqual(tags);

    const fetched = await authenticatedTestClient(adminToken).get(
      `/api/v1/documents/${created.body.id}`
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.tags).toEqual(tags);
  });

  /**
   * The regression guard for the fix, not a reproduction of the bug: it must
   * pass before and after. `buildDocumentContext` derives the condition context
   * key from the *stored* tag key, so a policy only authorizes when the stored
   * tag key and the stored condition key are the same string. Before the fix
   * both sides were rewritten (`cost_center` → `costCenter`) and so agreed by
   * coincidence; after it both are verbatim and agree by construction. This
   * pins that they never disagree — the failure mode being a policy that
   * silently authorizes nothing, or authorizes everything.
   */
  test('a multi-word tag key authorizes item access through its policy', async () => {
    const allowed = await authenticatedTestClient(adminToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: 'visible',
        tags: { cost_center: 'platform' },
      });
    const denied = await authenticatedTestClient(adminToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: 'hidden',
        tags: { cost_center: 'finance' },
      });

    expect(allowed.status).toBe(201);
    expect(denied.status).toBe(201);

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        name: 'Cost Center Scoped',
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['documents:GetDocument'],
              resource: ['*'],
              condition: {
                StringEquals: { 'soat:ResourceTag/cost_center': 'platform' },
              },
            },
          ],
        },
      });
    expect(policyRes.status).toBe(201);

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    const okRes = await authenticatedTestClient(userToken).get(
      `/api/v1/documents/${allowed.body.id}`
    );
    const denyRes = await authenticatedTestClient(userToken).get(
      `/api/v1/documents/${denied.body.id}`
    );

    expect(okRes.status).toBe(200);
    expect(denyRes.status).toBe(403);
  });
});
