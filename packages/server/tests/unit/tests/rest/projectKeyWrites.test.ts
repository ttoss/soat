import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A project-scoped key names its project, so a write it makes needs no
 * `project_id`: the route resolves the key's own. A caller that fronts this
 * API with one key per project never sends it.
 */
describe('Writes under a project-scoped key', () => {
  let projectKey: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'projectkeywrites',
      policyActions: [],
    });
    projectId = setup.projectId;
    const key = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/api-keys')
      .send({ name: 'project-key-writes', project_id: projectId });
    expect(key.status).toBe(201);
    projectKey = key.body.key as string;
  });

  describe('POST /api/v1/files/presigned-url', () => {
    test('issues a token in the key’s project with no project_id', async () => {
      const response = await authenticatedTestClient(projectKey)
        .post('/api/v1/files/presigned-url')
        .send({ filename: 'scoped.pdf', content_type: 'application/pdf' });

      expect(response.status).toBe(201);
      expect(response.body.upload_token).toMatch(/^upt_/);
      expect(response.body.upload_url).toContain(response.body.upload_token);
    });

    test('a project_id naming another project is refused', async () => {
      const other = await setupProjectWithUsers({
        prefix: 'projectkeywritesother',
        policyActions: [],
      });

      const response = await authenticatedTestClient(projectKey)
        .post('/api/v1/files/presigned-url')
        .send({ project_id: other.projectId, filename: 'x.pdf' });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/usage/thresholds', () => {
    test('creates a threshold in the key’s project with no project_id', async () => {
      const response = await authenticatedTestClient(projectKey)
        .post('/api/v1/usage/thresholds')
        .send({ metric: 'cost_usd', window: 'calendar_month', threshold: 50 });

      expect(response.status).toBe(201);
      expect(response.body.project_id).toBe(projectId);
    });
  });
});
