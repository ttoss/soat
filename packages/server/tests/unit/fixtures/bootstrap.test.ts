import { authenticatedTestClient } from '../testClient';
import { setupProjectWithUsers } from './bootstrap';

describe('setupProjectWithUsers', () => {
  test('creates admin/user/project/policy/noPerm and scopes the policy to only the given actions', async () => {
    const {
      adminToken,
      userToken,
      userId,
      projectId,
      otherProjectId,
      policyId,
      noPermToken,
    } = await setupProjectWithUsers({
      prefix: 'bootstrapfixture',
      policyActions: ['projects:GetProject'],
      createOtherProject: true,
    });

    expect(adminToken).toBeTruthy();
    expect(userToken).toBeTruthy();
    expect(userId).toBeTruthy();
    expect(projectId).toBeTruthy();
    expect(policyId).toBeTruthy();
    expect(noPermToken).toBeTruthy();
    expect(otherProjectId).toBeTruthy();
    expect(otherProjectId).not.toBe(projectId);

    const allowed = await authenticatedTestClient(userToken).get(
      `/api/v1/projects/${projectId}`
    );
    expect(allowed.status).toBe(200);

    const notGranted = await authenticatedTestClient(userToken).delete(
      `/api/v1/projects/${projectId}`
    );
    expect(notGranted.status).toBe(403);

    const noPermDenied = await authenticatedTestClient(
      noPermToken as string
    ).get(`/api/v1/projects/${projectId}`);
    expect(noPermDenied.status).toBe(403);
  });
});
