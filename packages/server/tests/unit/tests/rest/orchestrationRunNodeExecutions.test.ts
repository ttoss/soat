import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A run's node executions are a paged sub-resource of the run, oldest first:
 * reading them is reading the run, and the run itself carries none of them.
 */
describe('GET /api/v1/orchestration-runs/:orchestration_run_id/node-executions', () => {
  let userToken: string;
  let noPermToken: string;
  let runId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'nodeexecs',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
      ],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;

    const orchestration = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: setup.projectId,
        name: 'three transforms',
        nodes: [
          { id: 'first', type: 'transform', expression: 1 },
          { id: 'second', type: 'transform', expression: 2 },
          { id: 'third', type: 'transform', expression: 3 },
        ],
        edges: [
          { from: 'first', to: 'second' },
          { from: 'second', to: 'third' },
        ],
      });
    expect(orchestration.status).toBe(201);

    const run = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestration-runs')
      .send({ wait: true, orchestration_id: orchestration.body.id, input: {} });
    expect(run.status).toBe(201);
    expect(run.body.status).toBe('succeeded');
    runId = run.body.id;
  });

  const list = (query: Record<string, number> = {}, token = userToken) => {
    return authenticatedTestClient(token)
      .get(`/api/v1/orchestration-runs/${runId}/node-executions`)
      .query(query);
  };

  const nodeIds = (body: { data: Array<{ node_id: string }> }) => {
    return body.data.map((execution) => {
      return execution.node_id;
    });
  };

  test('lists every node execution, oldest first', async () => {
    const response = await list();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 3, limit: 50, offset: 0 });
    expect(nodeIds(response.body)).toEqual(['first', 'second', 'third']);
    expect(response.body.data[0]).toMatchObject({
      node_type: 'transform',
      attempt: 1,
      status: 'completed',
    });
  });

  test('an explicit page answers that slice', async () => {
    const response = await list({ limit: 1, offset: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(nodeIds(response.body)).toEqual(['second']);
  });

  test('the run itself carries no node executions', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/orchestration-runs/${runId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.node_executions).toBeUndefined();
  });

  test('returns 401 when unauthenticated', async () => {
    const response = await testClient.get(
      `/api/v1/orchestration-runs/${runId}/node-executions`
    );
    expect(response.status).toBe(401);
  });

  test('a caller who cannot read the run gets 404', async () => {
    const response = await list({}, noPermToken);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ORCHESTRATION_RUN_NOT_FOUND');
  });

  test('an unknown run returns 404', async () => {
    const response = await authenticatedTestClient(userToken).get(
      '/api/v1/orchestration-runs/orun_missing/node-executions'
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ORCHESTRATION_RUN_NOT_FOUND');
  });
});
