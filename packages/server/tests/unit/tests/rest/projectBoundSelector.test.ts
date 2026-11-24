import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A project-bound credential names its project, so no route needs the
 * `project_id` selector from it.
 */
describe('Project selection by a project-bound credential', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let boundKey: string;
  let boundToken: string;

  const PER_PROJECT_ROUTES = [
    '/api/v1/activity/export',
    '/api/v1/audit-log/export',
    '/api/v1/documents/export',
    '/api/v1/usage/aggregate',
  ];

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'bound-selector',
      policyActions: [
        'activity:ExportActivity',
        'audit:ExportAuditEntries',
        'documents:ExportDocuments',
        'usage:GetAggregate',
        'playbooks:ValidatePlaybook',
        'playbooks:ListPlaybooks',
        'iam:CreateToken',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({
        name: 'bound-selector-key',
        project_id: projectId,
        policy_ids: [setup.policyId],
      });
    expect(keyRes.status).toBe(201);
    boundKey = keyRes.body.key;

    const tokenRes = await authenticatedTestClient(boundKey)
      .post('/api/v1/iam/tokens')
      .send({ policy: { statement: [{ effect: 'Allow', action: ['*'] }] } });
    expect(tokenRes.status).toBe(201);
    boundToken = tokenRes.body.token;
  });

  describe.each(PER_PROJECT_ROUTES)('GET %s', (route) => {
    test('a bound key reads its project with no project_id', async () => {
      const res = await authenticatedTestClient(boundKey).get(route);
      expect(res.status).toBe(200);
    });

    test('an IAM token minted from a bound key reads its project', async () => {
      const res = await authenticatedTestClient(boundToken).get(route);
      expect(res.status).toBe(200);
    });

    test('an unbound credential still names the project', async () => {
      const res = await authenticatedTestClient(userToken).get(route);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('401 without a credential', async () => {
      const res = await testClient.get(route);
      expect(res.status).toBe(401);
    });
  });

  test('project_id is accepted', async () => {
    const res = await authenticatedTestClient(boundKey)
      .get('/api/v1/activity/export')
      .query({ project_id: projectId });
    expect(res.status).toBe(200);
  });

  test('POST /api/v1/playbooks/validate implies a bound key project for playbook_id', async () => {
    const res = await authenticatedTestClient(boundKey)
      .post('/api/v1/playbooks/validate')
      .send({
        definition: { nodes: [] },
        playbook_id: 'pbk_doesnotexist000',
      });
    expect(res.body.error?.message).not.toBe(
      'playbook_id requires project_id.'
    );
  });
});
