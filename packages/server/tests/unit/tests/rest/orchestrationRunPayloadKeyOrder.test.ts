import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A run's payloads read back with the keys in the order the caller wrote them.
 * Every key here has the same length, so a store that sorts keys would answer
 * `apple, mango, zebra`.
 */
describe('orchestration run payload key order', () => {
  const input = { zebra: 1, apple: { yak: 1, bee: 2 }, mango: 3 };
  const order = ['zebra', 'apple', 'mango'];

  let userToken: string;
  let run: {
    id: string;
    input: Record<string, unknown>;
    output: Record<string, { result: Record<string, unknown> }>;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'runkeyorder',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
      ],
    });
    userToken = setup.userToken;

    const orchestration = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: setup.projectId,
        name: 'echo input',
        nodes: [
          { id: 'echo', type: 'transform', expression: { var: 'input' } },
        ],
        edges: [],
      });
    expect(orchestration.status).toBe(201);

    const started = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestration-runs')
      .send({ wait: true, orchestration_id: orchestration.body.id, input });
    expect(started.status).toBe(201);
    expect(started.body.status).toBe('completed');

    const read = await authenticatedTestClient(userToken).get(
      `/api/v1/orchestration-runs/${started.body.id}`
    );
    expect(read.status).toBe(200);
    run = read.body;
  });

  test('the run input keeps its key order', () => {
    expect(Object.keys(run.input)).toEqual(order);
    expect(Object.keys(run.input.apple as object)).toEqual(['yak', 'bee']);
  });

  test('the run output keeps the order its node wrote', () => {
    expect(Object.keys(run.output.echo.result)).toEqual(order);
  });

  test('a node execution output keeps its key order', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/orchestration-runs/${run.id}/node-executions`
    );

    expect(response.status).toBe(200);
    expect(Object.keys(response.body.data[0].output.result)).toEqual(order);
  });
});
