import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const COMPANY = {
  nodes: [
    {
      id: 'profile',
      title: 'Company profile',
      kind: 'collect',
      final: true,
      inputs: [
        {
          name: 'regime',
          schema: { type: 'string' },
          required: true,
          source: 'manual',
        },
      ],
    },
  ],
};

const dependentDefinition = (args: {
  upstreamId: string;
  nodeId?: string;
  field?: string;
}) => {
  return {
    upstreams: [{ name: 'company', playbook_id: args.upstreamId }],
    nodes: [
      {
        id: 'company',
        title: 'Company',
        kind: 'upstream',
        upstream: { name: 'company', node_id: args.nodeId ?? 'profile' },
        inputs: [],
      },
      {
        id: 'dre',
        title: 'DRE',
        kind: 'collect',
        final: true,
        inputs: [
          {
            name: 'regime',
            schema: { type: 'string' },
            required: true,
            source: {
              node_id: 'company',
              field: args.field ?? 'output.regime',
            },
          },
        ],
      },
    ],
  };
};

describe('Playbook validation against the project', () => {
  let adminToken: string;
  let userToken: string;
  let validateOnlyToken: string;
  let listOnlyToken: string;
  let projectId: string;
  let otherProjectId: string;
  let companyId: string;
  let seq = 0;

  const newPlaybook = async (
    definition: unknown,
    project = projectId
  ): Promise<string> => {
    seq += 1;
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/playbooks')
      .send({ project_id: project, name: `playbook-${seq}`, definition });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const validate = (token: string, body: Record<string, unknown>) => {
    return authenticatedTestClient(token)
      .post('/api/v1/playbooks/validate')
      .send(body);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'playbookvalidateupstreams',
      policyActions: ['playbooks:ValidatePlaybook', 'playbooks:ListPlaybooks'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;
    validateOnlyToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'pbkvalidateonly',
      actions: ['playbooks:ValidatePlaybook'],
    });
    listOnlyToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'pbklistonly',
      actions: ['playbooks:ListPlaybooks'],
    });
    companyId = await newPlaybook(COMPANY);
  });

  describe('POST /api/v1/playbooks/validate', () => {
    test('answers valid for upstreams the project holds', async () => {
      const res = await validate(userToken, {
        project_id: projectId,
        definition: dependentDefinition({ upstreamId: companyId }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: true, problems: [] });
    });

    test('an upstream the project does not hold is UNKNOWN_UPSTREAM', async () => {
      const elsewhere = await newPlaybook(COMPANY, otherProjectId);
      const res = await validate(userToken, {
        project_id: projectId,
        definition: dependentDefinition({ upstreamId: elsewhere }),
      });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.problems).toContainEqual(
        expect.objectContaining({
          code: 'UNKNOWN_UPSTREAM',
          path: 'definition.upstreams[0].playbook_id',
        })
      );
    });

    test('a pulled node the upstream lacks is MISSING_NODE', async () => {
      const res = await validate(userToken, {
        project_id: projectId,
        definition: dependentDefinition({
          upstreamId: companyId,
          nodeId: 'nope',
        }),
      });
      expect(res.status).toBe(200);
      expect(res.body.problems).toContainEqual(
        expect.objectContaining({
          code: 'MISSING_NODE',
          path: 'definition.nodes[0].upstream.node_id',
        })
      );
    });

    test('a field the pulled node does not produce is UNKNOWN_FIELD', async () => {
      const res = await validate(userToken, {
        project_id: projectId,
        definition: dependentDefinition({
          upstreamId: companyId,
          field: 'output.sector',
        }),
      });
      expect(res.status).toBe(200);
      expect(res.body.problems).toContainEqual(
        expect.objectContaining({
          code: 'UNKNOWN_FIELD',
          path: 'definition.nodes[1].inputs[0].source.field',
        })
      );
    });

    test('with playbook_id, a definition reading itself back is UPSTREAM_CYCLE', async () => {
      const first = await newPlaybook(COMPANY);
      const second = await newPlaybook(
        dependentDefinition({ upstreamId: first })
      );
      const res = await validate(userToken, {
        project_id: projectId,
        playbook_id: first,
        definition: {
          ...COMPANY,
          upstreams: [{ name: 'dre', playbook_id: second }],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.problems).toContainEqual(
        expect.objectContaining({
          code: 'UPSTREAM_CYCLE',
          path: 'definition.upstreams[0].playbook_id',
        })
      );
    });

    test('without project_id, upstreams are not read', async () => {
      const res = await validate(userToken, {
        definition: dependentDefinition({
          upstreamId: 'pbk_doesNotExist000000',
        }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: true, problems: [] });
    });

    test('playbook_id without project_id is 400', async () => {
      const res = await validate(userToken, {
        playbook_id: companyId,
        definition: COMPANY,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('playbook_id outside the project is 404', async () => {
      const elsewhere = await newPlaybook(COMPANY, otherProjectId);
      const res = await validate(adminToken, {
        project_id: projectId,
        playbook_id: elsewhere,
        definition: COMPANY,
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('no credential is 401', async () => {
      const res = await testClient
        .post('/api/v1/playbooks/validate')
        .send({ project_id: projectId, definition: COMPANY });
      expect(res.status).toBe(401);
    });

    test.each([
      [
        'ValidatePlaybook alone',
        () => {
          return validateOnlyToken;
        },
      ],
      [
        'ListPlaybooks alone',
        () => {
          return listOnlyToken;
        },
      ],
    ])('with project_id, %s is 403', async (_label, token) => {
      const res = await validate(token(), {
        project_id: projectId,
        definition: COMPANY,
      });
      expect(res.status).toBe(403);
    });
  });
});
