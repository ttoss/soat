import { signRunToken } from 'src/lib/orchestrationRunToken';
import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const UPGRADE_ACTIONS = [
  'playbooks:UpgradePlaybookCase',
  'playbooks:ListPlaybookCaseUpgrades',
  'playbooks:GetPlaybookCase',
  'playbooks:PausePlaybookCase',
];

const amount = (schema: object = { type: 'number' }) => {
  return { name: 'amount', schema, required: true, source: 'manual' };
};

/** `revenue` collects an amount; `pricing` reads it. */
const V1 = {
  nodes: [
    { key: 'revenue', title: 'Revenue', kind: 'collect', inputs: [amount()] },
    {
      key: 'pricing',
      title: 'Pricing',
      kind: 'collect',
      final: true,
      inputs: [
        {
          name: 'revenue',
          schema: { type: 'number' },
          required: true,
          source: { node: 'revenue', field: 'output.amount' },
        },
      ],
    },
  ],
};

describe('Playbook case upgrades', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let readerToken: string;
  let projectId: string;
  let workflowId: string;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const newPlaybook = async (definition: object = V1) => {
    seq += 1;
    const res = await asAdmin()
      .post('/api/v1/playbooks')
      .send({ project_id: projectId, name: `upgrade-${seq}`, definition });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const newCase = async (playbookId: string) => {
    const res = await asAdmin()
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: `client-${seq}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const redefine = async (playbookId: string, definition: object) => {
    const res = await asAdmin()
      .patch(`/api/v1/playbooks/${playbookId}`)
      .send({ definition });
    expect(res.status).toBe(200);
    return res.body.version as number;
  };

  const writeAmount = async (caseId: string, value: number) => {
    const res = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: [
          { node: 'revenue', name: 'amount', value, expected_revision: null },
        ],
      });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
  };

  const upgrade = (
    caseId: string,
    body: Record<string, unknown> = {},
    token = userToken
  ) => {
    return authenticatedTestClient(token)
      .post(`/api/v1/playbook-cases/${caseId}/upgrade`)
      .send(body);
  };

  const nodeOf = (body: { nodes: Array<{ key: string }> }, key: string) => {
    return body.nodes.find((node) => {
      return node.key === key;
    }) as Record<string, unknown> | undefined;
  };

  const executionsOf = async (caseId: string) => {
    const res = await asAdmin().get(
      `/api/v1/playbook-cases/${caseId}/executions?limit=100`
    );
    return res.body.data as Array<Record<string, unknown>>;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'playbookupgrade',
      policyActions: UPGRADE_ACTIONS,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    readerToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'pbkupgradereader',
      actions: ['playbooks:GetPlaybookCase'],
    });
    const workflow = await asAdmin()
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: 'upgrade-review',
        states: [
          { name: 'open', initial: true },
          { name: 'done', terminal: true },
        ],
        transitions: [{ name: 'finish', from: ['open'], to: 'done' }],
      });
    workflowId = workflow.body.id;
  });

  describe('POST /api/v1/playbook-cases/{case_id}/upgrade', () => {
    test("moves the case to the playbook's current version and records it", async () => {
      const playbookId = await newPlaybook();
      const caseId = await newCase(playbookId);
      await writeAmount(caseId, 5);
      const version = await redefine(playbookId, {
        nodes: [
          ...V1.nodes,
          {
            key: 'contact',
            title: 'Contact',
            kind: 'collect',
            inputs: [
              {
                name: 'email',
                schema: { type: 'string' },
                required: true,
                source: 'manual',
              },
            ],
          },
        ],
      });

      const res = await upgrade(caseId);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: caseId, playbook_version: version });
      expect(nodeOf(res.body, 'contact')).toMatchObject({ state: 'blocked' });
      expect(nodeOf(res.body, 'pricing')).toMatchObject({ state: 'done' });

      const upgrades = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/upgrades`
      );
      expect(upgrades.status).toBe(200);
      expect(upgrades.body.data).toEqual([
        {
          id: expect.stringMatching(/^pbk_upg_/),
          case_id: caseId,
          from_version: 1,
          to_version: version,
          diff: { added: ['contact'], removed: [], changed: [] },
          created_by_principal_type: 'user',
          created_by_principal_id: expect.stringMatching(/^user_/),
          on_behalf_of: null,
          created_at: expect.any(String),
        },
      ]);
    });

    test('runs again a node whose input now reads another field', async () => {
      const playbookId = await newPlaybook();
      const caseId = await newCase(playbookId);
      await writeAmount(caseId, 5);
      const before = (await executionsOf(caseId)).length;
      await redefine(playbookId, {
        nodes: [
          V1.nodes[0],
          {
            ...V1.nodes[1],
            inputs: [
              {
                name: 'revenue',
                schema: { type: 'number' },
                required: true,
                source: { node: 'revenue', field: 'input.amount' },
              },
            ],
          },
        ],
      });

      const res = await upgrade(caseId);
      await flushPlaybookExecutions();

      expect(res.status).toBe(200);
      const executions = await executionsOf(caseId);
      expect(executions).toHaveLength(before + 1);
      expect(executions[0]).toMatchObject({
        node: 'pricing',
        status: 'succeeded',
        playbook_version: 2,
      });
      const upgrades = await asAdmin().get(
        `/api/v1/playbook-cases/${caseId}/upgrades`
      );
      expect(upgrades.body.data[0].diff.changed).toEqual([
        {
          node: 'pricing',
          executor: false,
          inputs: [{ name: 'revenue', change: 'source' }],
        },
      ]);
    });

    test('with wait it answers once the nodes it makes runnable settle', async () => {
      const playbookId = await newPlaybook();
      const caseId = await newCase(playbookId);
      await writeAmount(caseId, 5);
      await redefine(playbookId, {
        nodes: [
          V1.nodes[0],
          {
            ...V1.nodes[1],
            inputs: [
              {
                name: 'revenue',
                schema: { type: 'number' },
                required: true,
                source: { node: 'revenue', field: 'input.amount' },
              },
            ],
          },
        ],
      });

      const res = await upgrade(caseId, { wait: true });

      expect(res.status).toBe(200);
      expect(res.body.automation_status).toBe('idle');
      expect(nodeOf(res.body, 'pricing')).toMatchObject({
        state: 'done',
        output: { value: { revenue: 5 } },
      });
    });

    test('asks again for a value the new schema refuses', async () => {
      const playbookId = await newPlaybook();
      const caseId = await newCase(playbookId);
      await writeAmount(caseId, 5);
      await redefine(playbookId, {
        nodes: [
          {
            ...V1.nodes[0],
            inputs: [amount({ type: 'number', minimum: 10 })],
          },
          V1.nodes[1],
        ],
      });

      const res = await upgrade(caseId);

      expect(nodeOf(res.body, 'revenue')).toMatchObject({
        state: 'stale',
        missing: ['amount'],
      });
    });

    test('keeps the values of a removed node in the entries', async () => {
      const playbookId = await newPlaybook();
      const caseId = await newCase(playbookId);
      await writeAmount(caseId, 5);
      await redefine(playbookId, { nodes: [V1.nodes[0]] });

      const res = await upgrade(caseId);

      expect(nodeOf(res.body, 'pricing')).toBeUndefined();
      const entries = await asAdmin().get(
        `/api/v1/playbook-cases/${caseId}/entries?node=pricing`
      );
      expect(entries.body.total).toBeGreaterThan(0);
    });

    test('moves the case to the version named, an earlier one included', async () => {
      const playbookId = await newPlaybook();
      await redefine(playbookId, { nodes: [V1.nodes[0]] });
      const caseId = await newCase(playbookId);

      const res = await upgrade(caseId, { version: 1 });

      expect(res.status).toBe(200);
      expect(res.body.playbook_version).toBe(1);
      expect(nodeOf(res.body, 'pricing')).toBeDefined();
    });

    test('records nothing for the version the case is already on', async () => {
      const playbookId = await newPlaybook();
      const caseId = await newCase(playbookId);

      const res = await upgrade(caseId, { version: 1 });

      expect(res.status).toBe(200);
      expect(res.body.playbook_version).toBe(1);
      const upgrades = await asAdmin().get(
        `/api/v1/playbook-cases/${caseId}/upgrades`
      );
      expect(upgrades.body.total).toBe(0);
    });

    test('supersedes an execution queued but not started', async () => {
      const playbookId = await newPlaybook();
      const caseId = await newCase(playbookId);
      process.env.PLAYBOOK_WORKER_DISABLED = 'true';
      try {
        await writeAmount(caseId, 5);
        await redefine(playbookId, { nodes: [V1.nodes[0]] });
        const [queued] = await executionsOf(caseId);
        expect(queued.status).toBe('pending');

        const res = await upgrade(caseId);

        expect(res.status).toBe(200);
        const executions = await executionsOf(caseId);
        expect(
          executions.find((each) => {
            return each.id === queued.id;
          })
        ).toMatchObject({ result: 'superseded', output: null });
        expect(executions[0]).toMatchObject({
          status: 'pending',
          playbook_version: 2,
        });
      } finally {
        delete process.env.PLAYBOOK_WORKER_DISABLED;
      }
      await asAdmin().post(`/api/v1/playbook-cases/${caseId}/pause`);
    });

    test('returns 409 while an execution is running', async () => {
      const playbookId = await newPlaybook({
        nodes: [
          {
            key: 'review',
            title: 'Review',
            kind: 'execute',
            inputs: [amount()],
            executor: { type: 'workflow', id: workflowId },
          },
        ],
      });
      const caseId = await newCase(playbookId);
      await asAdmin()
        .post(`/api/v1/playbook-cases/${caseId}/inputs`)
        .send({
          inputs: [
            {
              node: 'review',
              name: 'amount',
              value: 1,
              expected_revision: null,
            },
          ],
        });
      await flushPlaybookExecutions();
      await redefine(playbookId, { nodes: [V1.nodes[0]] });

      const res = await upgrade(caseId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_CASE_BUSY');
      expect(res.body.error.meta.executions).toEqual([
        expect.objectContaining({ node: 'review' }),
      ]);
    });

    test('queues nothing on a paused case', async () => {
      const playbookId = await newPlaybook({ nodes: [V1.nodes[0]] });
      const caseId = await newCase(playbookId);
      await writeAmount(caseId, 5);
      await asAdmin().post(`/api/v1/playbook-cases/${caseId}/pause`);
      await redefine(playbookId, V1);

      const res = await upgrade(caseId);
      await flushPlaybookExecutions();

      expect(res.status).toBe(200);
      expect(nodeOf(res.body, 'pricing')).toMatchObject({ state: 'ready' });
      expect(
        (await executionsOf(caseId)).filter((each) => {
          return each.node === 'pricing';
        })
      ).toEqual([]);
    });

    test('returns 400 for a version the playbook does not have', async () => {
      const caseId = await newCase(await newPlaybook());

      const res = await upgrade(caseId, { version: 9 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 400 for a version that is not an integer', async () => {
      const caseId = await newCase(await newPlaybook());

      const res = await upgrade(caseId, { version: 'latest' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test("returns 403 for an upgrade from the case's own work", async () => {
      const caseId = await newCase(await newPlaybook());
      const me = await asAdmin().get('/api/v1/users/me');
      const token = await signRunToken({
        publicId: me.body.id,
        role: 'admin',
        projectPublicId: projectId,
        workPublicId: caseId,
      });

      const res = await upgrade(caseId, {}, token);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_SELF_WRITE');
    });

    test('returns 401 without a token', async () => {
      const res = await testClient
        .post('/api/v1/playbook-cases/pbk_case_missing/upgrade')
        .send({});
      expect(res.status).toBe(401);
    });

    test('returns 403 to a member without the action', async () => {
      const caseId = await newCase(await newPlaybook());
      const res = await upgrade(caseId, {}, readerToken);
      expect(res.status).toBe(403);
    });

    test('returns 404 to a caller without permission', async () => {
      const caseId = await newCase(await newPlaybook());
      const res = await upgrade(caseId, {}, noPermToken);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}/upgrades', () => {
    test('lists the upgrades, newest first', async () => {
      const playbookId = await newPlaybook();
      const caseId = await newCase(playbookId);
      await redefine(playbookId, { nodes: [V1.nodes[0]] });
      await upgrade(caseId);
      await upgrade(caseId, { version: 1 });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/upgrades`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.data).toMatchObject([
        { from_version: 2, to_version: 1 },
        { from_version: 1, to_version: 2 },
      ]);
    });

    test('returns 401 without a token', async () => {
      const res = await testClient.get(
        '/api/v1/playbook-cases/pbk_case_missing/upgrades'
      );
      expect(res.status).toBe(401);
    });

    test('returns 404 to a member without the action', async () => {
      const caseId = await newCase(await newPlaybook());
      const res = await authenticatedTestClient(readerToken).get(
        `/api/v1/playbook-cases/${caseId}/upgrades`
      );
      expect(res.status).toBe(404);
    });
  });
});
