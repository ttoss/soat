import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A policy `resource` built with an intrinsic is checked once it resolves, at
 * apply; a literal one is checked when the template is validated.
 */
describe('a policy resource built with an intrinsic', () => {
  let adminToken: string;
  let projectId: string;

  const client = () => {
    return authenticatedTestClient(adminToken);
  };

  const policyOn = (resource: unknown) => {
    return {
      parameters: { ProjectId: { type: 'string' } },
      resources: {
        ToolPolicy: {
          type: 'policy',
          properties: {
            document: {
              statement: [
                {
                  effect: 'Allow',
                  action: ['tools:CallTool'],
                  resource: [resource],
                },
              ],
            },
          },
        },
        Other: {
          type: 'policy',
          properties: {
            document: {
              statement: [{ effect: 'Allow', action: ['tools:ListTools'] }],
            },
          },
        },
      },
    };
  };

  const subResource = { sub: 'srn:${ProjectId}:tool:*' };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fmpolintr',
      policyActions: [],
      createOtherProject: false,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
  });

  test.each([
    ['sub', subResource],
    ['param', { param: 'ProjectId' }],
    ['ref', { ref: 'Other' }],
  ])('validate accepts a %s resource', async (_kind, resource) => {
    const res = await client()
      .post('/api/v1/formations/validate')
      .send({ template: policyOn(resource) });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, errors: [] });
  });

  test('plan accepts a sub resource', async () => {
    const res = await client()
      .post('/api/v1/formations/plan')
      .send({
        project_id: projectId,
        template: policyOn(subResource),
        parameters: { ProjectId: projectId },
      });

    expect(res.status).toBe(200);
    expect(res.body.changes).toHaveLength(2);
  });

  test('validate refuses a literal invalid resource', async () => {
    const res = await client()
      .post('/api/v1/formations/validate')
      .send({ template: policyOn('foo') });

    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual([
      {
        path: 'resources.ToolPolicy.properties.document',
        message: expect.stringContaining('statement[0].resource: "foo"'),
      },
    ]);
  });

  test('apply stores the resolved resource', async () => {
    const created = await client()
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'policy-sub',
        template: policyOn(subResource),
        parameters: { ProjectId: projectId },
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('active');

    const policyId = created.body.resources.find(
      (resource: { logical_id: string }) => {
        return resource.logical_id === 'ToolPolicy';
      }
    ).physical_resource_id;
    const policy = await client().get(`/api/v1/policies/${policyId}`);

    expect(policy.body.document.statement[0].resource).toEqual([
      `srn:${projectId}:tool:*`,
    ]);
  });

  test('apply refuses a sub resolving to an invalid resource', async () => {
    const created = await client()
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'policy-sub-invalid',
        template: policyOn({ sub: 'foo-${ProjectId}' }),
        parameters: { ProjectId: projectId },
      });

    expect(created.status).toBe(201);
    expect(created.body.status).toBe('failed');
    const policy = created.body.resources.find(
      (resource: { logical_id: string }) => {
        return resource.logical_id === 'ToolPolicy';
      }
    );
    expect(policy.physical_resource_id).toBeNull();
  });
});
