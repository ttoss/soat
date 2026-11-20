import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

describe('setupProjectWithUsers fixture', () => {
  test('rejects when the server refuses the policy', async () => {
    await expect(
      setupProjectWithUsers({
        prefix: 'fixturebadpolicy',
        policyActions: ['nosuchmodule:NoSuchAction'],
        createNoPermUser: false,
      })
    ).rejects.toThrow(/policy 400/);
  });

  test('policyActions: [] creates no policy', async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fixturenopolicy',
      policyActions: [],
      createNoPermUser: false,
    });
    expect(setup.policyId).toBeUndefined();
  });

  test('a second prefix in the same database gets a working admin token', async () => {
    await setupProjectWithUsers({
      prefix: 'fixturefirst',
      policyActions: [],
      createNoPermUser: false,
    });
    const second = await setupProjectWithUsers({
      prefix: 'fixturesecond',
      policyActions: ['agents:GetAgent'],
      createNoPermUser: false,
    });
    const project = await authenticatedTestClient(second.adminToken).get(
      `/api/v1/projects/${second.projectId}`
    );
    expect(project.status).toBe(200);
  });
});
