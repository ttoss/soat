import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import { setupProjectWithUsers, testGrant } from '../../fixtures/bootstrap';
import { createPlaybookCase } from '../../fixtures/playbookCase';
import { authenticatedTestClient, testClient } from '../../testClient';

const CASE_ACTIONS = [
  'playbooks:CreatePlaybookCase',
  'playbooks:GetPlaybookCase',
  'playbooks:WritePlaybookCaseInputs',
  'playbooks:GetPlaybookCaseMissing',
  'playbooks:ConfirmPlaybookCaseNode',
];

const MARRIED = { '==': [{ var: 'married' }, true] };

/**
 * A spouse is asked for only when the person is married; a summary copies the
 * spouse only when flagged; a note's condition fails to evaluate; a review
 * needs a witness only for a couple.
 */
const DEFINITION = {
  nodes: [
    {
      id: 'intake',
      title: 'Intake',
      kind: 'collect',
      inputs: [
        {
          name: 'married',
          schema: { type: 'boolean' },
          required: true,
          source: 'manual',
        },
        {
          name: 'spouse',
          schema: { type: 'string', minLength: 1 },
          required: MARRIED,
          description: 'The spouse full name',
          source: 'manual',
        },
      ],
    },
    {
      id: 'summary',
      title: 'Summary',
      kind: 'collect',
      inputs: [
        {
          name: 'copy_spouse',
          schema: { type: 'boolean' },
          required: false,
          source: 'manual',
        },
        {
          name: 'spouse',
          schema: { type: 'string' },
          required: { var: 'copy_spouse' },
          source: { node_id: 'intake', field: 'output.spouse' },
        },
      ],
    },
    {
      id: 'faulty',
      title: 'Faulty',
      kind: 'collect',
      inputs: [
        {
          name: 'label',
          schema: { type: 'string' },
          required: false,
          source: 'manual',
        },
        {
          name: 'note',
          schema: { type: 'string' },
          required: { round: [{ var: 'label' }] },
          source: 'manual',
        },
      ],
    },
    {
      id: 'review',
      title: 'Review',
      kind: 'confirm',
      inputs: [
        {
          name: 'couple',
          schema: { type: 'boolean' },
          required: true,
          source: 'manual',
        },
        {
          name: 'witness',
          schema: { type: 'string' },
          required: { var: 'couple' },
          source: 'manual',
        },
      ],
    },
  ],
};

type NodeBody = {
  id: string;
  state: string;
  missing: string[];
  blocked_by: string[];
  inputs: { name: string; revision: number | null }[];
};

describe('Playbook inputs required on a condition', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let playbookId: string;
  let seq = 0;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const newCase = async () => {
    seq += 1;
    const res = await createPlaybookCase({
      client: asUser(),
      playbookId,
      body: { subject: `conditional-${seq}` },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const nodeOf = async (caseId: string, key: string): Promise<NodeBody> => {
    const res = await asUser().get(`/api/v1/playbook-cases/${caseId}`);
    return res.body.nodes.find((node: NodeBody) => {
      return node.id === key;
    });
  };

  const write = async (
    caseId: string,
    nodeId: string,
    values: Record<string, unknown>
  ) => {
    const node = await nodeOf(caseId, nodeId);
    const res = await asUser()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: Object.entries(values).map(([name, value]) => {
          return {
            node_id: nodeId,
            name,
            value,
            expected_revision:
              node.inputs.find((input) => {
                return input.name === name;
              })?.revision ?? null,
          };
        }),
      });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
  };

  const missingOf = (caseId: string, nodeId: string, token = userToken) => {
    return authenticatedTestClient(token).get(
      `/api/v1/playbook-cases/${caseId}/missing?node_id=${nodeId}`
    );
  };

  const confirmReview = async (caseId: string) => {
    const review = await nodeOf(caseId, 'review');
    return asUser()
      .post(`/api/v1/playbook-cases/${caseId}/nodes/review/confirmation`)
      .send({
        decision: 'approve',
        expected_revisions: Object.fromEntries(
          review.inputs.map((input) => {
            return [input.name, input.revision];
          })
        ),
      });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'playbookconditional',
      policyActions: CASE_ACTIONS,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    const playbook = await authenticatedTestClient(adminToken)
      .post('/api/v1/playbooks')
      .send({
        policy_ids: await testGrant({ token: adminToken }),
        project_id: setup.projectId,
        name: 'conditional-intake',
        definition: DEFINITION,
      });
    expect(playbook.status).toBe(201);
    playbookId = playbook.body.id;
  });

  describe('GET /api/v1/playbook-cases/{case_id}', () => {
    test('an input whose condition reads an unset sibling is not missing', async () => {
      const caseId = await newCase();

      expect(await nodeOf(caseId, 'intake')).toMatchObject({
        state: 'blocked',
        missing: ['married'],
      });
    });

    test('a sibling value that meets the condition makes the input missing', async () => {
      const caseId = await newCase();
      await write(caseId, 'intake', { married: true });

      expect(await nodeOf(caseId, 'intake')).toMatchObject({
        state: 'blocked',
        missing: ['spouse'],
      });
    });

    test('a sibling value that fails the condition lets the node settle', async () => {
      const caseId = await newCase();
      await write(caseId, 'intake', { married: false });

      expect(await nodeOf(caseId, 'intake')).toMatchObject({
        state: 'done',
        missing: [],
      });
    });

    test('a done node whose condition turns true on an unset input is no longer done', async () => {
      const caseId = await newCase();
      await write(caseId, 'intake', { married: false });
      await write(caseId, 'intake', { married: true });

      expect(await nodeOf(caseId, 'intake')).toMatchObject({
        state: 'stale',
        missing: ['spouse'],
      });
    });

    test('a sourced input waits for its node only while its condition holds', async () => {
      const caseId = await newCase();

      expect((await nodeOf(caseId, 'summary')).blocked_by).toEqual([]);

      await write(caseId, 'summary', { copy_spouse: true });

      expect(await nodeOf(caseId, 'summary')).toMatchObject({
        state: 'stale',
        blocked_by: ['intake'],
      });
    });

    test('an expression that fails to evaluate makes the input required', async () => {
      const caseId = await newCase();

      expect((await nodeOf(caseId, 'faulty')).missing).toEqual(['note']);
    });

    test('returns 401 without a token', async () => {
      const caseId = await newCase();
      const res = await testClient.get(`/api/v1/playbook-cases/${caseId}`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}/missing', () => {
    test('reports the required answer resolved for the case', async () => {
      const caseId = await newCase();
      await write(caseId, 'intake', { married: false });

      const before = await missingOf(caseId, 'intake');

      expect(before.status).toBe(200);
      expect(before.body.waves).toEqual([
        [
          {
            case_id: caseId,
            node_id: 'intake',
            input: 'spouse',
            schema: { type: 'string', minLength: 1 },
            description: 'The spouse full name',
            required: false,
          },
        ],
      ]);

      await write(caseId, 'intake', { married: true });

      const after = await missingOf(caseId, 'intake');

      expect(after.body.waves).toEqual([
        [expect.objectContaining({ input: 'spouse', required: true })],
      ]);
    });

    test('reports a failing expression as required', async () => {
      const caseId = await newCase();

      const res = await missingOf(caseId, 'faulty');

      expect(res.body.waves).toEqual([
        [
          expect.objectContaining({ input: 'label', required: false }),
          expect.objectContaining({ input: 'note', required: true }),
        ],
      ]);
    });

    test('returns 404 to a caller without permission', async () => {
      const caseId = await newCase();
      const res = await missingOf(caseId, 'intake', noPermToken);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/playbook-cases/{case_id}/nodes/{node}/confirmation', () => {
    test('refuses a confirm node whose conditionally required input is unset', async () => {
      const caseId = await newCase();
      await write(caseId, 'review', { couple: true });

      const res = await confirmReview(caseId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_NODE_NOT_CONFIRMABLE');
      expect(res.body.error.meta.missing).toEqual(['witness']);
    });

    test('confirms when the condition is false', async () => {
      const caseId = await newCase();
      await write(caseId, 'review', { couple: false });

      const res = await confirmReview(caseId);

      expect(res.status).toBe(200);
      expect(await nodeOf(caseId, 'review')).toMatchObject({ state: 'done' });
    });
  });
});
