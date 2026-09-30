import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * A run belongs to its orchestration's project, whichever projects the caller
 * can reach: a credential spanning several must not move the run, its records
 * or its references into another one.
 */
describe('POST /api/v1/orchestration-runs', () => {
  let adminToken: string;
  let twoProjectToken: string;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'runscope',
      policyActions: [],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    const user = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'runscopetwo', password: 'runscopetwopass' });
    const policy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['orchestrations:StartRun', 'orchestrations:GetRun'],
              resource: [`srn:${projectId}:*:*`, `srn:${otherProjectId}:*:*`],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${user.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    twoProjectToken = await loginAs('runscopetwo', 'runscopetwopass');
  });

  test.each([
    [
      'the first project in scope',
      () => {
        return projectId;
      },
    ],
    [
      'the second project in scope',
      () => {
        return otherProjectId;
      },
    ],
  ])(
    "records the run in the orchestration's project (%s)",
    async (_label, target) => {
      const orchestration = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: target(),
          name: 'Scoped Run',
          nodes: [
            {
              id: 'start',
              type: 'transform',
              expression: 1,
              state_mapping: { 'state.result': { var: 'output.result' } },
            },
          ],
          edges: [],
          state_schema: {},
          input_schema: {},
        });
      expect(orchestration.status).toBe(201);

      const run = await authenticatedTestClient(twoProjectToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestration.body.id, wait: true });

      expect(run.status).toBe(201);
      expect(run.body.project_id).toBe(target());
    }
  );
});
