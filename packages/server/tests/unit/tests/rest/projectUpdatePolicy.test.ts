import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('PATCH /api/v1/projects/:id under a project-scoped policy', () => {
  let adminToken: string;
  let granteeToken: string;
  let noGrantToken: string;
  let projectId: string;
  let otherProjectId: string;

  const patch = (args: { token: string; id: string; body: object }) => {
    return authenticatedTestClient(args.token)
      .patch(`/api/v1/projects/${args.id}`)
      .send(args.body);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'projupdpol',
      policyActions: ['projects:GetProject'],
      createOtherProject: true,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    granteeToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'projupdpolgrantee',
      actions: ['projects:GetProject', 'projects:UpdateProject'],
    });
    noGrantToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'projupdpolnogrant',
      actions: ['projects:GetProject'],
    });
  });

  test('a non-admin granted projects:UpdateProject updates its project', async () => {
    const res = await patch({
      token: granteeToken,
      id: projectId,
      body: {
        name: 'Granted Rename',
        trace_content_retention_days: 30,
        max_chain_generations: 5,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Granted Rename');
    expect(res.body.trace_content_retention_days).toBe(30);
    expect(res.body.max_chain_generations).toBe(5);
  });

  test('the grant does not reach another project', async () => {
    const res = await patch({
      token: granteeToken,
      id: otherProjectId,
      body: { name: 'Not Mine' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('a non-admin without the grant is 403', async () => {
    const res = await patch({
      token: noGrantToken,
      id: projectId,
      body: { name: 'No Grant' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('unauthenticated is 401', async () => {
    const res = await testClient
      .patch(`/api/v1/projects/${projectId}`)
      .send({ name: 'Anonymous' });

    expect(res.status).toBe(401);
  });

  test('admin still updates any project', async () => {
    const res = await patch({
      token: adminToken,
      id: otherProjectId,
      body: { name: 'Admin Rename' },
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Admin Rename');
  });

  describe('through a key the grantee mints', () => {
    let keyToken: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(granteeToken)
        .post('/api/v1/api-keys')
        .send({ name: 'grantee key', project_id: projectId });
      expect(res.status).toBe(201);
      keyToken = res.body.key as string;
    });

    test('updates the key project', async () => {
      const res = await patch({
        token: keyToken,
        id: projectId,
        body: { name: 'Key Rename' },
      });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Key Rename');
    });

    test('another project is API_KEY_PROJECT_SCOPE', async () => {
      const res = await patch({
        token: keyToken,
        id: otherProjectId,
        body: { name: 'Key Not Mine' },
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_PROJECT_SCOPE');
    });
  });

  test('detaching a guardrail still needs guardrails:DetachGuardrail', async () => {
    const guardrail = await authenticatedTestClient(adminToken)
      .post('/api/v1/guardrails')
      .send({
        project_id: projectId,
        name: 'projupdpol floor',
        document: { class: 'C' },
      });
    expect(guardrail.status).toBe(201);
    const attach = await patch({
      token: granteeToken,
      id: projectId,
      body: { guardrail_ids: [guardrail.body.id] },
    });
    expect(attach.status).toBe(200);

    const detach = await patch({
      token: granteeToken,
      id: projectId,
      body: { guardrail_ids: [] },
    });

    expect(detach.status).toBe(403);
    expect(detach.body.error.code).toBe('FORBIDDEN');
  });
});
