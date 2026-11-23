import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A formation's policy grants in the formation's project only, and every
 * route that knows that project refuses the template before applying it.
 */
describe("a formation's policy grants in the formation's project only", () => {
  let adminToken: string;
  let projectId: string;
  let otherProjectId: string;

  const client = () => {
    return authenticatedTestClient(adminToken);
  };

  const policyOn = (resource: string) => {
    return {
      resources: {
        Res: {
          type: 'policy',
          properties: {
            document: {
              statement: [
                {
                  effect: 'Allow',
                  action: ['tools:ListTools'],
                  resource: [resource],
                },
              ],
            },
          },
        },
      },
    };
  };

  const elsewhere = () => {
    return policyOn(`srn:${otherProjectId}:*:*`);
  };

  const refusal = () => {
    return [
      {
        path: 'resources.Res.properties.document',
        message: `Allow resource 'srn:${otherProjectId}:*:*' is outside the policy's project; name srn:${projectId}:<type>:<id>, or omit resource for every resource of the project.`,
      },
    ];
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fmpolproj',
      policyActions: [],
      createOtherProject: true,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
  });

  describe('POST /api/v1/formations/plan', () => {
    test("refuses an Allow naming another project's resources", async () => {
      const res = await client()
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, template: elsewhere() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.details).toEqual(refusal());
    });

    test("accepts an Allow naming the formation's project", async () => {
      const res = await client()
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          template: policyOn(`srn:${projectId}:tool:*`),
        });

      expect(res.status).toBe(200);
      expect(res.body.changes[0].action).toBe('create');
    });
  });

  describe('POST /api/v1/formations', () => {
    test("refuses an Allow naming another project's resources", async () => {
      const res = await client().post('/api/v1/formations').send({
        project_id: projectId,
        name: 'elsewhere',
        template: elsewhere(),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.meta.details).toEqual(refusal());
    });
  });

  describe('PUT /api/v1/formations/:formation_id', () => {
    test("refuses an Allow naming another project's resources", async () => {
      const created = await client()
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'in-project',
          template: policyOn(`srn:${projectId}:tool:*`),
        });
      expect(created.body.status).toBe('active');

      const res = await client()
        .put(`/api/v1/formations/${created.body.id}`)
        .send({ template: elsewhere() });

      expect(res.status).toBe(400);
      expect(res.body.error.meta.details).toEqual(refusal());
    });
  });

  describe('POST /api/v1/formations/validate', () => {
    test('names no project, so leaves a concrete project id to the apply', async () => {
      const res = await client()
        .post('/api/v1/formations/validate')
        .send({ template: elsewhere() });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ valid: true, errors: [] });
    });
  });
});
