import { signRunToken } from 'src/lib/orchestrationRunToken';
import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, testClient } from '../../testClient';

const CASE_ACTIONS = [
  'playbooks:CreatePlaybookCase',
  'playbooks:GetPlaybookCase',
  'playbooks:WritePlaybookCaseInputs',
  'playbooks:ConfirmPlaybookCaseNode',
  'playbooks:ListPlaybookCaseEntries',
];

/** Revenue is collected, approved by a person, then priced from the approval. */
const definitionWith = (doubleToolId: string) => {
  return {
    nodes: [
      {
        id: 'revenue',
        title: 'Revenue',
        kind: 'collect',
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: 'manual',
          },
        ],
      },
      {
        id: 'approve',
        title: 'Approve the revenue',
        kind: 'confirm',
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: { node_id: 'revenue', field: 'output.amount' },
          },
        ],
      },
      {
        id: 'pricing',
        title: 'Pricing',
        kind: 'execute',
        final: true,
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: { node_id: 'approve', field: 'output.amount' },
          },
        ],
        executor: {
          type: 'tool',
          id: doubleToolId,
          input: { value: { var: 'amount' } },
        },
      },
    ],
  };
};

describe('Playbook confirmations', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let playbookId: string;
  let workflowPlaybookId: string;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const newCase = async (playbook = playbookId) => {
    seq += 1;
    const res = await asAdmin()
      .post(`/api/v1/playbooks/${playbook}/cases`)
      .send({ subject: `confirm-${seq}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const writeAmount = async (caseId: string, value: number) => {
    const current = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    const res = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: [
          {
            node_id: current.body.nodes[0].id,
            name: 'amount',
            value,
            expected_revision: current.body.nodes[0].inputs[0].revision,
          },
        ],
      });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
  };

  const nodeOf = async (caseId: string, key: string) => {
    const res = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    return res.body.nodes.find((node: { id: string }) => {
      return node.id === key;
    });
  };

  /** Confirms on the revisions the node reads now, unless told otherwise. */
  const confirm = async (
    caseId: string,
    body: Record<string, unknown>,
    token = userToken
  ) => {
    const approve = await nodeOf(caseId, 'approve');
    const res = await authenticatedTestClient(token)
      .post(`/api/v1/playbook-cases/${caseId}/nodes/approve/confirmation`)
      .send({
        expected_revisions: { amount: approve.inputs[0].revision },
        ...body,
      });
    await flushPlaybookExecutions();
    return res;
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/double': (request) => {
          return { body: { doubled: Number(request.body.value) * 2 } };
        },
      },
    });
    const setup = await setupProjectWithUsers({
      prefix: 'playbookconfirm',
      policyActions: CASE_ACTIONS,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;

    const tool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'confirm-double',
        type: 'http',
        description: 'Doubles a value',
        parameters: { type: 'object', properties: {} },
        execute: { url: `${stub.baseUrl}/double`, method: 'POST' },
      });
    const playbook = await asAdmin()
      .post('/api/v1/playbooks')
      .send({
        project_id: projectId,
        name: 'confirmed-pricing',
        definition: definitionWith(tool.body.id),
      });
    expect(playbook.status).toBe(201);
    playbookId = playbook.body.id;

    const workflow = await asAdmin()
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: 'confirm-review',
        states: [
          { name: 'open', initial: true },
          { name: 'done', terminal: true },
        ],
        transitions: [{ name: 'finish', from: ['open'], to: 'done' }],
      });
    const workflowPlaybook = await asAdmin()
      .post('/api/v1/playbooks')
      .send({
        project_id: projectId,
        name: 'reviewed',
        definition: {
          nodes: [
            {
              id: 'review',
              title: 'Review',
              kind: 'execute',
              inputs: [
                {
                  name: 'amount',
                  schema: { type: 'number' },
                  required: true,
                  source: 'manual',
                },
              ],
              executor: { type: 'workflow', id: workflow.body.id },
            },
          ],
        },
      });
    workflowPlaybookId = workflowPlaybook.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/playbook-cases/{case_id}/nodes/{node}/confirmation', () => {
    test('an approval becomes the output, and the nodes reading it run', async () => {
      const caseId = await newCase();
      await writeAmount(caseId, 5);
      expect(await nodeOf(caseId, 'approve')).toMatchObject({
        state: 'ready',
        output: null,
      });
      expect((await nodeOf(caseId, 'pricing')).blocked_by).toEqual(['approve']);

      const res = await confirm(caseId, { decision: 'approve' });

      expect(res.status).toBe(200);
      expect(await nodeOf(caseId, 'approve')).toMatchObject({
        state: 'done',
        output: { value: { amount: 5 } },
      });
      expect((await nodeOf(caseId, 'pricing')).output.value).toEqual({
        doubled: 10,
      });
    });

    test('with wait it answers once the cascade it starts settles', async () => {
      const caseId = await newCase();
      await writeAmount(caseId, 5);
      const approve = await nodeOf(caseId, 'approve');

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbook-cases/${caseId}/nodes/approve/confirmation`)
        .send({
          decision: 'approve',
          expected_revisions: { amount: approve.inputs[0].revision },
          wait: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.automation_status).toBe('idle');
      const pricing = res.body.nodes.find((node: { id: string }) => {
        return node.id === 'pricing';
      });
      expect(pricing).toMatchObject({
        state: 'done',
        output: { value: { doubled: 10 } },
      });
    });

    test('a rejection holds the node and its readers until its inputs change', async () => {
      const caseId = await newCase();
      await writeAmount(caseId, 5);

      const rejected = await confirm(caseId, {
        decision: 'reject',
        reason: 'Not what was filed',
      });

      expect(rejected.status).toBe(200);
      expect((await nodeOf(caseId, 'approve')).state).toBe('rejected');
      expect((await nodeOf(caseId, 'pricing')).state).toBe('blocked');
      const entries = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/entries?node_id=approve`
      );
      expect(entries.body.data[0]).toMatchObject({
        kind: 'rejection',
        value: { reason: 'Not what was filed' },
      });

      await writeAmount(caseId, 6);
      expect((await nodeOf(caseId, 'approve')).state).toBe('ready');
    });

    test('an approval lifts a rejection on the same inputs', async () => {
      const caseId = await newCase();
      await writeAmount(caseId, 5);
      await confirm(caseId, { decision: 'reject', reason: 'Check it' });

      await confirm(caseId, { decision: 'approve' });

      expect((await nodeOf(caseId, 'approve')).state).toBe('done');
    });

    test('a changed input stales the confirmation and holds its readers', async () => {
      const caseId = await newCase();
      await writeAmount(caseId, 5);
      await confirm(caseId, { decision: 'approve' });

      await writeAmount(caseId, 7);

      expect((await nodeOf(caseId, 'approve')).state).toBe('stale');
      expect((await nodeOf(caseId, 'pricing')).blocked_by).toEqual(['approve']);
    });

    test('returns 409 when an input moved since it was read', async () => {
      const caseId = await newCase();
      await writeAmount(caseId, 5);

      const res = await confirm(caseId, {
        decision: 'approve',
        expected_revisions: { amount: 1 },
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_INPUT_CONFLICT');
      expect(res.body.error.meta.conflicts).toEqual([
        {
          node_id: 'approve',
          input: 'amount',
          expected_revision: 1,
          current_revision: 2,
        },
      ]);
    });

    test('returns 409 for a node that cannot be confirmed', async () => {
      const caseId = await newCase();

      const blocked = await confirm(caseId, { decision: 'approve' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('PLAYBOOK_NODE_NOT_CONFIRMABLE');
      expect(blocked.body.error.meta.blocked_by).toEqual(['revenue']);

      const collect = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbook-cases/${caseId}/nodes/revenue/confirmation`)
        .send({ decision: 'approve', expected_revisions: { amount: null } });
      expect(collect.status).toBe(409);
      expect(collect.body.error.code).toBe('PLAYBOOK_NODE_NOT_CONFIRMABLE');
    });

    test.each([
      ['a rejection without a reason', { decision: 'reject' }],
      ['an unknown decision', { decision: 'maybe' }],
      [
        'no expected_revisions',
        { decision: 'approve', expected_revisions: undefined },
      ],
    ])('returns 400 for %s', async (_label, body) => {
      const caseId = await newCase();
      await writeAmount(caseId, 5);
      const res = await confirm(caseId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 400 for a node the version does not declare', async () => {
      const caseId = await newCase();
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbook-cases/${caseId}/nodes/nope/confirmation`)
        .send({ decision: 'approve', expected_revisions: {} });
      expect(res.status).toBe(400);
    });

    test('returns 401 without a token', async () => {
      const res = await testClient
        .post(
          '/api/v1/playbook-cases/pbk_case_absent/nodes/approve/confirmation'
        )
        .send({ decision: 'approve', expected_revisions: {} });
      expect(res.status).toBe(401);
    });

    test('returns 404 to a caller without permission', async () => {
      const caseId = await newCase();
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/playbook-cases/${caseId}/nodes/approve/confirmation`)
        .send({ decision: 'approve', expected_revisions: {} });
      expect(res.status).toBe(404);
    });
  });

  describe("writes from a case's own work", () => {
    /** A run-as token, as the work named `work` would carry. */
    const runTokenFor = async (work: string) => {
      const me = await asAdmin().get('/api/v1/users/me');
      return signRunToken({
        publicId: me.body.id,
        role: 'admin',
        projectPublicId: projectId,
        workPublicId: work,
      });
    };

    const writeAs = (caseId: string, token: string) => {
      return authenticatedTestClient(token)
        .post(`/api/v1/playbook-cases/${caseId}/inputs`)
        .send({
          inputs: [
            {
              node_id: 'review',
              name: 'amount',
              value: 9,
              expected_revision: 1,
            },
          ],
        });
    };

    test('refuses a write from the task an execution started', async () => {
      const caseId = await newCase(workflowPlaybookId);
      await writeAmount(caseId, 1);
      const executions = await asAdmin().get(
        `/api/v1/playbook-cases/${caseId}/executions`
      );
      const [parked] = executions.body.data;
      expect(parked.run_id).toMatch(/^task_/);

      for (const work of [parked.run_id, parked.id, caseId]) {
        const res = await writeAs(caseId, await runTokenFor(work));
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('PLAYBOOK_SELF_WRITE');
      }
    });

    test("admits a write from another case's work", async () => {
      const caseId = await newCase(workflowPlaybookId);
      await writeAmount(caseId, 1);

      const res = await writeAs(caseId, await runTokenFor('orun_elsewhere'));

      expect(res.status).toBe(200);
    });

    test('refuses a confirmation from the case itself', async () => {
      const caseId = await newCase();
      await writeAmount(caseId, 5);

      const res = await confirm(
        caseId,
        { decision: 'approve' },
        await runTokenFor(caseId)
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_SELF_WRITE');
    });
  });
});
