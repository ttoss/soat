import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A project-bound credential names its project, so no route needs the
 * `project_id` selector from it; `PROJECT_ID_QUERY_DISABLED` takes the selector
 * out of every route's query.
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

  const withSetting = async (run: () => Promise<void>) => {
    const saved = process.env.PROJECT_ID_QUERY_DISABLED;
    process.env.PROJECT_ID_QUERY_DISABLED = 'true';
    try {
      await run();
    } finally {
      if (saved === undefined) delete process.env.PROJECT_ID_QUERY_DISABLED;
      else process.env.PROJECT_ID_QUERY_DISABLED = saved;
    }
  };

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

    test('with the setting on, project_id is an unknown parameter', async () => {
      await withSetting(async () => {
        const res = await authenticatedTestClient(boundKey)
          .get(route)
          .query({ project_id: projectId });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(res.body.error.meta.unknown_query_parameters).toEqual([
          'project_id',
        ]);
        expect(res.body.error.meta.accepted_query_parameters).not.toContain(
          'project_id'
        );

        const implied = await authenticatedTestClient(boundKey).get(route);
        expect(implied.status).toBe(200);
      });
    });
  });

  test('with the setting off, project_id is still accepted', async () => {
    const res = await authenticatedTestClient(boundKey)
      .get('/api/v1/activity/export')
      .query({ project_id: projectId });
    expect(res.status).toBe(200);
  });

  test('with the setting on, the served spec declares no project_id query parameter', async () => {
    const declaresProjectIdQuery = (spec: {
      paths: Record<string, Record<string, unknown>>;
    }): boolean => {
      return Object.values(spec.paths).some((pathItem) => {
        return Object.values(pathItem).some((operation) => {
          const parameters = (operation as { parameters?: unknown })
            ?.parameters;
          return (
            Array.isArray(parameters) &&
            parameters.some((p: { name?: string; in?: string }) => {
              return p?.name === 'project_id' && p?.in === 'query';
            })
          );
        });
      });
    };

    const before = await authenticatedTestClient(boundKey).get(
      '/api/v1/openapi.json'
    );
    expect(declaresProjectIdQuery(before.body)).toBe(true);

    await withSetting(async () => {
      const res = await authenticatedTestClient(boundKey).get(
        '/api/v1/openapi.json'
      );
      expect(res.status).toBe(200);
      expect(declaresProjectIdQuery(res.body)).toBe(false);
    });
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
