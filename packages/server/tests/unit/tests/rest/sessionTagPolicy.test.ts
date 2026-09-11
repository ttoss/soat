import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `soat:ResourceTag/<key>` conditions on session routes.
 *
 * Sessions advertised `tags` in the spec and the docs long before IAM could
 * read them: every route authorized at project level only, against no SRN and
 * no tag context, so a conditioned statement was silently ignored (#1278).
 *
 * The two halves are reached by different policy shapes, the same way they are
 * for actors and documents: an item route evaluates the statement against the
 * one session it loaded, so an `Allow` condition gates it; a list cannot load
 * rows before authorizing them, so it authorizes the *type*
 * (`srn:<project>:session:*`, no tag context) and narrows with the compiled
 * `WHERE`, where a `Deny` condition is what removes rows.
 */
describe('Session tag policies', () => {
  let adminToken: string;
  let userId: string;
  let userToken: string;
  let projectId: string;
  let agentId: string;
  let prodSessionId: string;
  let stagingSessionId: string;

  const createTaggedSession = async (args: {
    name: string;
    tags: Record<string, string>;
  }) => {
    const created = await authenticatedTestClient(adminToken)
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, name: args.name });
    expect(created.status).toBe(201);

    const tagged = await authenticatedTestClient(adminToken)
      .put(`/api/v1/sessions/${created.body.id}/tags`)
      .send(args.tags);
    expect(tagged.status).toBe(200);

    return created.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'sesstagpol',
      policyActions: ['agents:CreateAgent'],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userId = setup.userId;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Session Tag Policy Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderRes.body.id,
        name: 'Session Tag Policy Agent',
      });
    agentId = agentRes.body.id;

    prodSessionId = await createTaggedSession({
      name: 'Prod Session',
      tags: { env: 'prod' },
    });
    stagingSessionId = await createTaggedSession({
      name: 'Staging Session',
      tags: { env: 'staging' },
    });

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        name: 'Session Env Scoped',
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['agents:GetSession'],
              resource: ['*'],
              condition: {
                StringEquals: { 'soat:ResourceTag/env': 'prod' },
              },
            },
            {
              effect: 'Allow',
              action: ['agents:ListSessions'],
              resource: ['*'],
            },
            {
              effect: 'Deny',
              action: ['agents:ListSessions'],
              resource: ['*'],
              condition: {
                StringEquals: { 'soat:ResourceTag/env': 'staging' },
              },
            },
          ],
        },
      });
    expect(policyRes.status).toBe(201);

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyRes.body.id] });
  });

  test('a conditioned policy allows the matching session', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/sessions/${prodSessionId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(prodSessionId);
  });

  test('a conditioned policy forbids a session carrying another value', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/sessions/${stagingSessionId}`
    );

    expect(response.status).toBe(403);
  });

  test('the tag sub-resource is gated by the same condition', async () => {
    const allowed = await authenticatedTestClient(userToken).get(
      `/api/v1/sessions/${prodSessionId}/tags`
    );
    const denied = await authenticatedTestClient(userToken).get(
      `/api/v1/sessions/${stagingSessionId}/tags`
    );

    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ env: 'prod' });
    expect(denied.status).toBe(403);
  });

  test('the list drops the sessions a conditioned Deny removes', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/sessions?project_id=${projectId}`
    );

    expect(response.status).toBe(200);
    expect(
      response.body.data.map((session: { id: string }) => {
        return session.id;
      })
    ).toEqual([prodSessionId]);
  });

  test('the list narrows to the requested project', async () => {
    const otherProjectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Session Tag Policy Other Project' });

    const response = await authenticatedTestClient(adminToken).get(
      `/api/v1/sessions?project_id=${otherProjectRes.body.id}`
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  test('an unknown project id is rejected', async () => {
    const response = await authenticatedTestClient(userToken).get(
      '/api/v1/sessions?project_id=proj_nonexistent'
    );

    expect(response.status).toBe(403);
  });
});
