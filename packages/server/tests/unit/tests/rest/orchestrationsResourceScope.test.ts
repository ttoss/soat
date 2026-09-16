import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * Orchestrations authorize per orchestration, not per project — on the
 * orchestration's own routes, on its version history, and on its runs.
 *
 * A **run** authorizes through the orchestration it runs, the way a memory
 * authorizes through its store: the SRN is
 * `srn:<project>:orchestration:<orchestration_id>`, which is the resource type
 * these routes have always probed. Naming the run itself would be a new type in
 * the public policy vocabulary and would stop an existing
 * `srn:<project>:orchestration:*` statement from covering run actions (#1339).
 */
describe('a policy scoped to one orchestration does not reach another', () => {
  let adminToken: string;
  let projectId: string;
  let scopedToken: string;
  let allowedId: string;
  let otherId: string;
  let allowedRunId: string;
  let otherRunId: string;

  const ORCHESTRATION_ACTIONS = [
    'orchestrations:GetOrchestration',
    'orchestrations:UpdateOrchestration',
    'orchestrations:DeleteOrchestration',
    'orchestrations:ListOrchestrationVersions',
    'orchestrations:GetOrchestrationVersion',
    'orchestrations:RestoreOrchestrationVersion',
    'orchestrations:GetRun',
    'orchestrations:CancelRun',
    'orchestrations:ListOrchestrations',
  ];

  const createOrchestration = async (name: string): Promise<string> => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name,
        nodes: [{ id: 'start', type: 'transform', expression: 42 }],
        edges: [],
      });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  const startRun = async (orchestrationId: string): Promise<string> => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/orchestration-runs')
      .send({ wait: true, orchestration_id: orchestrationId, input: {} });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'orchscope',
      policyActions: ORCHESTRATION_ACTIONS,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    allowedId = await createOrchestration('Scoped Orchestration');
    otherId = await createOrchestration('Other Orchestration');
    allowedRunId = await startRun(allowedId);
    otherRunId = await startRun(otherId);

    const scopedUser = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'orchscopescoped', password: 'orchScopePass1' });
    const scopedPolicy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ORCHESTRATION_ACTIONS,
              resource: [`srn:${projectId}:orchestration:${allowedId}`],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${scopedUser.body.id}/policies`)
      .send({ policy_ids: [scopedPolicy.body.id] });
    scopedToken = await loginAs('orchscopescoped', 'orchScopePass1');
  });

  describe('GET /api/v1/orchestrations/:orchestration_id', () => {
    test('reaches the orchestration the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/orchestrations/${allowedId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedId);
    });

    test('hides a sibling orchestration in the same project', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/orchestrations/${otherId}`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/orchestrations/:orchestration_id', () => {
    test('refuses a sibling orchestration', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/orchestrations/${otherId}`)
        .send({ description: 'Rewritten by a caller I may not touch.' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('reaches the orchestration the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/orchestrations/${allowedId}`)
        .send({ description: 'Scoped rewrite.' });

      expect(response.status).toBe(200);
      expect(response.body.description).toBe('Scoped rewrite.');
    });
  });

  describe('GET /api/v1/orchestrations/:orchestration_id/versions', () => {
    test('reaches the orchestration the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/orchestrations/${allowedId}/versions`
      );

      expect(response.status).toBe(200);
    });

    test('hides a sibling orchestration', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/orchestrations/${otherId}/versions`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/orchestrations/:orchestration_id/versions/:version', () => {
    test('reaches the orchestration the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/orchestrations/${allowedId}/versions/1`
      );

      expect(response.status).toBe(200);
    });

    test('hides a sibling orchestration', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/orchestrations/${otherId}/versions/1`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/orchestrations/:orchestration_id/versions/:version/restore', () => {
    test('refuses a sibling orchestration', async () => {
      const response = await authenticatedTestClient(scopedToken).post(
        `/api/v1/orchestrations/${otherId}/versions/1/restore`
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('reaches the orchestration the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).post(
        `/api/v1/orchestrations/${allowedId}/versions/1/restore`
      );

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/v1/orchestration-runs/:orchestration_run_id', () => {
    test('reaches a run of the orchestration the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/orchestration-runs/${allowedRunId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedRunId);
    });

    test('hides a run of a sibling orchestration', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/orchestration-runs/${otherRunId}`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/orchestration-runs/:orchestration_run_id/cancel', () => {
    test('refuses a run of a sibling orchestration', async () => {
      const response = await authenticatedTestClient(scopedToken).post(
        `/api/v1/orchestration-runs/${otherRunId}/cancel`
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    // 409 is what a finished run answers once the call is authorized: the
    // refusal is gone and the run's own state is what stops the cancel.
    test('reaches a run of the orchestration the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).post(
        `/api/v1/orchestration-runs/${allowedRunId}/cancel`
      );

      expect(response.status).toBe(409);
    });
  });

  describe('DELETE /api/v1/orchestrations/:orchestration_id', () => {
    test('refuses a sibling orchestration', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/orchestrations/${otherId}`
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('reaches the orchestration the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/orchestrations/${allowedId}`
      );

      expect(response.status).toBe(204);
    });
  });
});
