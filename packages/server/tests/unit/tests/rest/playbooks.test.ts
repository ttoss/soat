import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const PLAYBOOK_ACTIONS = [
  'playbooks:CreatePlaybook',
  'playbooks:ValidatePlaybook',
  'playbooks:ListPlaybooks',
  'playbooks:GetPlaybook',
  'playbooks:UpdatePlaybook',
  'playbooks:DeletePlaybook',
  'playbooks:ListPlaybookVersions',
  'playbooks:GetPlaybookVersion',
  'playbooks:RestorePlaybookVersion',
  'playbooks:CreatePlaybookCase',
  'tools:CallTool',
  'deciders:CreateDecision',
];

/** Revenue is filled by a person; the regime reads it; pricing reads both. */
const DEFINITION = {
  nodes: [
    {
      id: 'revenue',
      title: 'Annual revenue',
      kind: 'collect',
      inputs: [
        {
          name: 'annual_revenue',
          schema: { type: 'number', minimum: 0 },
          required: true,
          description: 'Gross revenue over the last twelve months, in BRL',
          source: 'manual',
        },
      ],
    },
    {
      id: 'tax_regime',
      title: 'Tax regime',
      kind: 'execute',
      inputs: [
        {
          name: 'annual_revenue',
          schema: { type: 'number' },
          required: true,
          source: { node_id: 'revenue', field: 'output.annual_revenue' },
        },
        {
          name: 'cnae',
          schema: { type: 'string', pattern: '^\\d{7}$' },
          required: true,
          source: 'manual',
        },
      ],
      executor: { type: 'decider', id: 'dcd_V1StGXR8Z5jdHi6B' },
    },
    {
      id: 'pricing',
      title: 'Pricing',
      kind: 'execute',
      final: true,
      inputs: [
        {
          name: 'regime',
          schema: { type: 'string' },
          required: true,
          source: { node_id: 'tax_regime', field: 'output' },
        },
        {
          name: 'margin',
          schema: { type: 'number' },
          required: false,
          source: 'manual',
        },
      ],
      executor: { type: 'tool', id: 'tool_V1StGXR8Z5jdHi6B' },
      transformations: [
        { name: 'proposal', format: 'pdf', tool: 'tool_V1StGXR8Z5jdHi6B' },
      ],
    },
  ],
};

describe('Playbooks', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let noPermToken: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const createPlaybook = (
    token: string,
    body: Record<string, unknown> = {}
  ) => {
    return authenticatedTestClient(token)
      .post('/api/v1/playbooks')
      .send({
        project_id: projectId,
        name: unique('pricing'),
        definition: DEFINITION,
        ...body,
      });
  };

  const newPlaybook = async (body: Record<string, unknown> = {}) => {
    const res = await createPlaybook(adminToken, body);
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number };
  };

  const newCase = async (playbookId: string) => {
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: 'ACME Ltda' });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'playbooks',
      policyActions: PLAYBOOK_ACTIONS,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken!;
  });

  describe('POST /api/v1/playbooks', () => {
    test('creates a playbook at version 1', async () => {
      const res = await createPlaybook(userToken);

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^pbk_/);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.version).toBe(1);
      expect(res.body.definition.nodes).toHaveLength(3);
      expect(res.body.definition.nodes[0].final).toBe(false);
    });

    test('returns 401 without a token', async () => {
      const res = await testClient
        .post('/api/v1/playbooks')
        .send({ project_id: projectId, name: 'x', definition: DEFINITION });
      expect(res.status).toBe(401);
    });

    test('returns 403 without permission', async () => {
      const res = await createPlaybook(noPermToken);
      expect(res.status).toBe(403);
    });

    test('lists every graph problem of an invalid definition', async () => {
      const res = await createPlaybook(adminToken, {
        definition: {
          nodes: [
            {
              id: 'a',
              title: 'A',
              kind: 'execute',
              inputs: [
                {
                  name: 'x',
                  schema: {},
                  required: true,
                  source: { node_id: 'b', field: 'output' },
                },
              ],
            },
            {
              id: 'b',
              title: 'B',
              kind: 'collect',
              inputs: [
                {
                  name: 'y',
                  schema: {},
                  required: true,
                  source: { node_id: 'a', field: 'output' },
                },
              ],
              executor: { type: 'tool', id: 'tool_x' },
            },
          ],
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_VALIDATION_FAILED');
      const codes = res.body.error.meta.problems.map(
        (problem: { code: string }) => {
          return problem.code;
        }
      );
      expect(codes).toEqual(
        expect.arrayContaining([
          'EXECUTOR_REQUIRED',
          'EXECUTOR_FORBIDDEN',
          'CYCLE',
        ])
      );
    });

    test('returns 400 for a node id holding a dot', async () => {
      const res = await createPlaybook(adminToken, {
        definition: {
          nodes: [{ id: 'a.b', title: 'A', kind: 'collect', inputs: [] }],
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 409 for a name already used in the project', async () => {
      const name = unique('dup');
      await newPlaybook({ name });
      const res = await createPlaybook(adminToken, { name });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NAME_CONFLICT');
    });

    test('returns 400 for a description that is not a string', async () => {
      const res = await createPlaybook(adminToken, { description: 5 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 403 when the writer may not start an executor', async () => {
      const token = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'pbkwriternostart',
        actions: ['playbooks:CreatePlaybook', 'tools:CallTool'],
      });
      const res = await createPlaybook(token);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_EXECUTOR_FORBIDDEN');
      expect(res.body.error.meta).toEqual({
        node_id: 'tax_regime',
        action: 'deciders:CreateDecision',
      });
    });

    test('returns 400 for a blank name', async () => {
      const res = await createPlaybook(adminToken, { name: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/playbooks/validate', () => {
    test('answers valid for a sound definition', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/playbooks/validate')
        .send({ definition: DEFINITION });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: true, problems: [] });
    });

    test('lists problems without writing', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/playbooks/validate')
        .send({
          definition: {
            nodes: [
              {
                id: 'a',
                title: 'A',
                kind: 'collect',
                inputs: [
                  {
                    name: 'x',
                    schema: {},
                    required: true,
                    source: { node_id: 'missing', field: 'output' },
                  },
                ],
              },
            ],
          },
        });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.problems).toEqual([
        {
          code: 'MISSING_NODE',
          path: 'definition.nodes[0].inputs[0].source.node_id',
          message: expect.stringContaining("'missing'"),
        },
      ]);
    });

    test('returns 401 without a token', async () => {
      const res = await testClient
        .post('/api/v1/playbooks/validate')
        .send({ definition: DEFINITION });
      expect(res.status).toBe(401);
    });

    const node = (fields: Record<string, unknown> = {}) => {
      return { id: 'a', title: 'A', kind: 'collect', inputs: [], ...fields };
    };
    const input = (fields: Record<string, unknown> = {}) => {
      return node({
        inputs: [
          {
            name: 'x',
            schema: {},
            required: true,
            source: 'manual',
            ...fields,
          },
        ],
      });
    };
    const executor = (fields: Record<string, unknown> = {}) => {
      return node({
        kind: 'execute',
        executor: { type: 'tool', id: 'tool_V1StGXR8Z5jdHi6B', ...fields },
      });
    };
    const transformation = (fields: Record<string, unknown> = {}) => {
      return node({
        final: true,
        transformations: [
          {
            name: 'proposal',
            format: 'pdf',
            tool: 'tool_V1StGXR8Z5jdHi6B',
            ...fields,
          },
        ],
      });
    };

    test.each([
      ['no nodes', []],
      [
        'too many nodes',
        Array.from({ length: 201 }, () => {
          return node();
        }),
      ],
      ['a node that is not an object', ['a']],
      ['an empty title', [node({ title: ' ' })]],
      ['an unknown kind', [node({ kind: 'review' })]],
      ['a non-boolean final', [node({ final: 'yes' })]],
      ['a non-string node description', [node({ description: 5 })]],
      ['inputs that are not an array', [node({ inputs: 'x' })]],
      ['too many inputs', [node({ inputs: Array.from({ length: 51 }) })]],
      ['an input that is not an object', [node({ inputs: ['x'] })]],
      ['a schema that is not an object', [input({ schema: 'number' })]],
      ['a non-boolean required', [input({ required: 'yes' })]],
      ['a non-string input description', [input({ description: 5 })]],
      ['an unknown source', [input({ source: 'agent' })]],
      ['an executor that is not an object', [node({ executor: 'tool' })]],
      ['an unknown executor type', [executor({ type: 'webhook' })]],
      ['an empty executor id', [executor({ id: '' })]],
      [
        'transformations that are not an array',
        [node({ transformations: 'x' })],
      ],
      [
        'a transformation that is not an object',
        [node({ transformations: ['x'] })],
      ],
      ['an empty transformation format', [transformation({ format: '' })]],
      ['an empty transformation tool', [transformation({ tool: '' })]],
    ])('returns 400 for %s', async (_label, nodes) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/playbooks/validate')
        .send({ definition: { nodes } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 400 for a definition without nodes', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/playbooks/validate')
        .send({ definition: {} });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/playbooks', () => {
    test('lists the project playbooks', async () => {
      const playbook = await newPlaybook();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbooks?project_id=${projectId}`
      );
      expect(res.status).toBe(200);
      expect(
        res.body.data.map((row: { id: string }) => {
          return row.id;
        })
      ).toContain(playbook.id);
    });

    test('returns 401 without a token', async () => {
      const res = await testClient.get('/api/v1/playbooks');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/playbooks/{playbook_id}', () => {
    test('returns the playbook', async () => {
      const playbook = await newPlaybook();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbooks/${playbook.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(playbook.id);
    });

    test('returns 404 to a caller without permission', async () => {
      const playbook = await newPlaybook();
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/playbooks/${playbook.id}`
      );
      expect(res.status).toBe(404);
    });

    test('returns 404 for an unknown id', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/playbooks/pbk_doesnotexist0000'
      );
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/playbooks/{playbook_id}', () => {
    test('bumps the version only when the definition changes', async () => {
      const playbook = await newPlaybook();

      const renamed = await authenticatedTestClient(userToken)
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({ name: unique('renamed') });
      expect(renamed.status).toBe(200);
      expect(renamed.body.version).toBe(1);

      const changed = await authenticatedTestClient(userToken)
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({
          definition: {
            nodes: [{ id: 'only', title: 'Only', kind: 'collect', inputs: [] }],
          },
        });
      expect(changed.status).toBe(200);
      expect(changed.body.version).toBe(2);
    });

    test('updates the description without a new version', async () => {
      const playbook = await newPlaybook({ description: 'Before' });
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({ description: null });
      expect(res.status).toBe(200);
      expect(res.body.description).toBeNull();
      expect(res.body.version).toBe(1);
    });

    test('returns 409 for a name another playbook holds', async () => {
      const name = unique('taken');
      await newPlaybook({ name });
      const playbook = await newPlaybook();
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({ name });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NAME_CONFLICT');
    });

    test('returns 409 for a stale expected_version', async () => {
      const playbook = await newPlaybook();
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({
          expected_version: 7,
          definition: {
            nodes: [{ id: 'only', title: 'Only', kind: 'collect', inputs: [] }],
          },
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('VERSION_CONFLICT');
    });

    test('returns 403 without permission', async () => {
      const playbook = await newPlaybook();
      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({ name: 'x' });
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('versions', () => {
    test('lists, reads and restores archived definitions', async () => {
      const playbook = await newPlaybook();
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({
          definition: {
            nodes: [{ id: 'only', title: 'Only', kind: 'collect', inputs: [] }],
          },
        });

      const list = await authenticatedTestClient(userToken).get(
        `/api/v1/playbooks/${playbook.id}/versions`
      );
      expect(list.status).toBe(200);
      expect(
        list.body.data.map((row: { version: number }) => {
          return row.version;
        })
      ).toEqual([2, 1]);

      const first = await authenticatedTestClient(userToken).get(
        `/api/v1/playbooks/${playbook.id}/versions/1`
      );
      expect(first.status).toBe(200);
      expect(first.body.playbook_id).toBe(playbook.id);
      expect(first.body.config.definition.nodes).toHaveLength(3);

      const restored = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbooks/${playbook.id}/versions/1/restore`)
        .send({});
      expect(restored.status).toBe(200);
      expect(restored.body.version).toBe(3);
      expect(restored.body.definition.nodes).toHaveLength(3);
    });

    test('returns 400 for a version that is not a positive integer', async () => {
      const playbook = await newPlaybook();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbooks/${playbook.id}/versions/0`
      );
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/v1/playbooks/{playbook_id}', () => {
    test('deletes a playbook with no cases', async () => {
      const playbook = await newPlaybook();
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/playbooks/${playbook.id}`
      );
      expect(res.status).toBe(204);

      const read = await authenticatedTestClient(adminToken).get(
        `/api/v1/playbooks/${playbook.id}`
      );
      expect(read.status).toBe(404);
    });

    test('returns 409 while the playbook has cases', async () => {
      const playbook = await newPlaybook();
      await newCase(playbook.id);
      const res = await authenticatedTestClient(adminToken).delete(
        `/api/v1/playbooks/${playbook.id}`
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_HAS_CASES');
    });
  });
});
