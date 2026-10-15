import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const CASE_ACTIONS = [
  'playbooks:CreatePlaybookCase',
  'playbooks:ListPlaybookCases',
  'playbooks:GetPlaybookCase',
  'playbooks:DeletePlaybookCase',
  'playbooks:WritePlaybookCaseInputs',
  'playbooks:GetPlaybookCaseMissing',
  'playbooks:ListPlaybookCaseEntries',
];

/** Revenue and the CNAE are filled by a person; pricing reads the revenue. */
const DEFINITION = {
  nodes: [
    {
      key: 'revenue',
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
      key: 'activity',
      title: 'Activity',
      kind: 'collect',
      inputs: [
        {
          name: 'cnae',
          schema: { type: 'string', pattern: '^\\d{7}$' },
          required: true,
          source: 'manual',
        },
      ],
    },
    {
      key: 'pricing',
      title: 'Pricing',
      kind: 'execute',
      final: true,
      inputs: [
        {
          name: 'revenue',
          schema: { type: 'number' },
          required: true,
          source: { node: 'revenue', field: 'output.annual_revenue' },
        },
        {
          name: 'margin',
          schema: { type: 'number' },
          required: true,
          source: 'manual',
        },
      ],
      executor: { type: 'tool', id: 'tool_V1StGXR8Z5jdHi6B' },
    },
  ],
};

describe('Playbook cases', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let noPermToken: string;
  let playbookId: string;
  let seq = 0;

  const newCase = async (token = adminToken) => {
    seq += 1;
    const res = await authenticatedTestClient(token)
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: `client-${seq}` });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  const writeInputs = (
    caseId: string,
    inputs: Record<string, unknown>[],
    token = userToken
  ) => {
    return authenticatedTestClient(token)
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({ inputs });
  };

  const nodeOf = (body: { nodes: { key: string }[] }, key: string) => {
    return body.nodes.find((node) => {
      return node.key === key;
    }) as Record<string, unknown>;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'playbookcases',
      policyActions: CASE_ACTIONS,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken!;

    const playbook = await authenticatedTestClient(adminToken)
      .post('/api/v1/playbooks')
      .send({
        project_id: projectId,
        name: 'client-pricing',
        definition: DEFINITION,
      });
    expect(playbook.status).toBe(201);
    playbookId = playbook.body.id;
  });

  describe('POST /api/v1/playbooks/{playbook_id}/cases', () => {
    test('creates a case pinned to the current version', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbooks/${playbookId}/cases`)
        .send({ subject: 'ACME Ltda' });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^pbk_case_/);
      expect(res.body.playbook_id).toBe(playbookId);
      expect(res.body.playbook_version).toBe(1);
      expect(res.body.revision).toBe(0);
      expect(nodeOf(res.body, 'revenue').state).toBe('blocked');
      expect(nodeOf(res.body, 'revenue').missing).toEqual(['annual_revenue']);
      expect(nodeOf(res.body, 'pricing').state).toBe('blocked');
      expect(nodeOf(res.body, 'pricing').waiting).toEqual(['revenue']);
    });

    test('returns 401 without a token', async () => {
      const res = await testClient
        .post(`/api/v1/playbooks/${playbookId}/cases`)
        .send({ subject: 'x' });
      expect(res.status).toBe(401);
    });

    test('returns 404 to a caller without permission', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/playbooks/${playbookId}/cases`)
        .send({ subject: 'x' });
      expect(res.status).toBe(404);
    });

    test('returns 400 without a subject', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbooks/${playbookId}/cases`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/playbook-cases/{case_id}/inputs', () => {
    test('writes a batch and advances the revision', async () => {
      const playbookCase = await newCase();
      const res = await writeInputs(playbookCase.id, [
        {
          node: 'revenue',
          name: 'annual_revenue',
          value: 4_000_000,
          expected_revision: null,
        },
        {
          node: 'activity',
          name: 'cnae',
          value: '6201501',
          expected_revision: null,
        },
      ]);

      expect(res.status).toBe(200);
      expect(res.body.revision).toBe(2);
      const revenue = nodeOf(res.body, 'revenue');
      expect(revenue.missing).toEqual([]);
      expect(revenue.inputs).toEqual([
        { name: 'annual_revenue', value: 4_000_000, revision: 1 },
      ]);
    });

    test('refuses the whole batch when a field moved on', async () => {
      const playbookCase = await newCase();
      await writeInputs(playbookCase.id, [
        {
          node: 'revenue',
          name: 'annual_revenue',
          value: 1,
          expected_revision: null,
        },
      ]);

      const res = await writeInputs(playbookCase.id, [
        {
          node: 'activity',
          name: 'cnae',
          value: '6201501',
          expected_revision: null,
        },
        {
          node: 'revenue',
          name: 'annual_revenue',
          value: 2,
          expected_revision: null,
        },
      ]);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_INPUT_CONFLICT');
      expect(res.body.error.meta.conflicts).toEqual([
        {
          node: 'revenue',
          input: 'annual_revenue',
          expected_revision: null,
          current_revision: 1,
        },
      ]);

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${playbookCase.id}`
      );
      expect(read.body.revision).toBe(1);
      expect(nodeOf(read.body, 'activity').missing).toEqual(['cnae']);
    });

    test('writes no revision for a value equal to the current one', async () => {
      const playbookCase = await newCase();
      const write = (expected: number | null) => {
        return writeInputs(playbookCase.id, [
          {
            node: 'revenue',
            name: 'annual_revenue',
            value: 10,
            expected_revision: expected,
          },
        ]);
      };
      await write(null);
      const res = await write(1);
      expect(res.status).toBe(200);
      expect(res.body.revision).toBe(1);
    });

    test('returns 400 for a value its schema refuses', async () => {
      const playbookCase = await newCase();
      const res = await writeInputs(playbookCase.id, [
        {
          node: 'activity',
          name: 'cnae',
          value: '62-01',
          expected_revision: null,
        },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_INPUT_INVALID');
      expect(res.body.error.meta).toEqual({ node: 'activity', input: 'cnae' });
    });

    test('returns 400 for an input that reads another node', async () => {
      const playbookCase = await newCase();
      const res = await writeInputs(playbookCase.id, [
        { node: 'pricing', name: 'revenue', value: 1, expected_revision: null },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_INPUT_INVALID');
    });

    test('returns 400 for an input the version does not declare', async () => {
      const playbookCase = await newCase();
      const res = await writeInputs(playbookCase.id, [
        { node: 'revenue', name: 'nope', value: 1, expected_revision: null },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_INPUT_INVALID');
    });

    test('returns 401 without a token', async () => {
      const playbookCase = await newCase();
      const res = await testClient
        .post(`/api/v1/playbook-cases/${playbookCase.id}/inputs`)
        .send({ inputs: [] });
      expect(res.status).toBe(401);
    });

    test('returns 404 to a caller without permission', async () => {
      const playbookCase = await newCase();
      const res = await writeInputs(
        playbookCase.id,
        [
          {
            node: 'revenue',
            name: 'annual_revenue',
            value: 1,
            expected_revision: null,
          },
        ],
        noPermToken
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}/missing', () => {
    test('lists the manual inputs still to fill, by wave', async () => {
      const playbookCase = await newCase();
      await writeInputs(playbookCase.id, [
        {
          node: 'revenue',
          name: 'annual_revenue',
          value: 1,
          expected_revision: null,
        },
      ]);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${playbookCase.id}/missing?node=pricing`
      );

      expect(res.status).toBe(200);
      expect(res.body.node).toBe('pricing');
      expect(res.body.waves).toEqual([
        [{ node: 'pricing', input: 'margin', schema: { type: 'number' } }],
      ]);
    });

    test('returns 400 for a node the version does not declare', async () => {
      const playbookCase = await newCase();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${playbookCase.id}/missing?node=nope`
      );
      expect(res.status).toBe(400);
    });

    test('returns 404 to a caller without permission', async () => {
      const playbookCase = await newCase();
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/playbook-cases/${playbookCase.id}/missing?node=pricing`
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}/entries', () => {
    test('lists every value written, newest first', async () => {
      const playbookCase = await newCase();
      await writeInputs(playbookCase.id, [
        {
          node: 'revenue',
          name: 'annual_revenue',
          value: 1,
          expected_revision: null,
        },
      ]);
      await writeInputs(playbookCase.id, [
        {
          node: 'revenue',
          name: 'annual_revenue',
          value: 2,
          expected_revision: 1,
        },
      ]);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${playbookCase.id}/entries?node=revenue`
      );
      expect(res.status).toBe(200);
      expect(
        res.body.data.map((entry: { revision: number; value: number }) => {
          return [entry.revision, entry.value];
        })
      ).toEqual([
        [2, 2],
        [1, 1],
      ]);
      expect(res.body.data[0].id).toMatch(/^pbk_ent_/);
      expect(res.body.data[0].kind).toBe('input');
      expect(res.body.data[0].input).toBe('annual_revenue');
    });
  });

  describe('GET /api/v1/playbook-cases', () => {
    test('lists a playbook cases', async () => {
      const playbookCase = await newCase();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases?project_id=${projectId}&playbook_id=${playbookId}`
      );
      expect(res.status).toBe(200);
      const ids = res.body.data.map((row: { id: string }) => {
        return row.id;
      });
      expect(ids).toContain(playbookCase.id);
      expect(res.body.data[0].nodes).toBeUndefined();
    });

    test('an unknown playbook filters to nothing', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases?project_id=${projectId}&playbook_id=pbk_doesnotexist0000`
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    test('returns 401 without a token', async () => {
      const res = await testClient.get('/api/v1/playbook-cases');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}', () => {
    test('stays on its version after the playbook changes', async () => {
      const playbookCase = await newCase();
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/playbooks/${playbookId}`)
        .send({
          definition: {
            nodes: [
              ...DEFINITION.nodes,
              { key: 'extra', title: 'Extra', kind: 'collect', inputs: [] },
            ],
          },
        });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${playbookCase.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.playbook_version).toBe(1);
      expect(res.body.nodes).toHaveLength(3);
    });

    test('returns 404 for an unknown id', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/playbook-cases/pbk_case_doesnotexist0000'
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/playbook-cases/{case_id}', () => {
    test('deletes a case and its entries', async () => {
      const playbookCase = await newCase();
      await writeInputs(playbookCase.id, [
        {
          node: 'revenue',
          name: 'annual_revenue',
          value: 1,
          expected_revision: null,
        },
      ]);
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/playbook-cases/${playbookCase.id}`
      );
      expect(res.status).toBe(204);

      const read = await authenticatedTestClient(adminToken).get(
        `/api/v1/playbook-cases/${playbookCase.id}`
      );
      expect(read.status).toBe(404);
    });

    test('returns 404 to a caller without permission', async () => {
      const playbookCase = await newCase();
      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/playbook-cases/${playbookCase.id}`
      );
      expect(res.status).toBe(404);
    });
  });
});
