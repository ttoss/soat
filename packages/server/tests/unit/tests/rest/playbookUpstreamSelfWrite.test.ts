import { signRunToken } from 'src/lib/orchestrationRunToken';
import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import { pollUntil } from '../../fixtures/agentToolTurn';
import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const PROFILE = {
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
};

const APPROVAL = {
  id: 'approval',
  title: 'Approval',
  kind: 'confirm',
  inputs: [
    {
      name: 'regime',
      schema: { type: 'string' },
      required: true,
      source: { node_id: 'profile', field: 'output.regime' },
    },
  ],
};

/** Reads `upstream`'s `profile` and parks an execution on a workflow task. */
const dependentDefinition = (args: {
  upstreamId: string;
  workflowId: string;
}) => {
  return {
    upstreams: [{ name: 'company', playbook_id: args.upstreamId }],
    nodes: [
      {
        id: 'profile',
        title: 'Company',
        kind: 'upstream',
        upstream: { name: 'company', node_id: 'profile' },
        inputs: [],
      },
      {
        id: 'review',
        title: 'Review',
        kind: 'execute',
        inputs: [
          {
            name: 'regime',
            schema: { type: 'string' },
            required: true,
            source: { node_id: 'profile', field: 'output.regime' },
          },
        ],
        executor: { type: 'workflow', id: args.workflowId },
      },
    ],
  };
};

type CaseBody = {
  id: string;
  nodes: { id: string; inputs: { name: string; revision: number | null }[] }[];
};

describe("Playbook writes from a dependent case's own work", () => {
  let adminToken: string;
  let projectId: string;
  let companyId: string;
  let dependentId: string;
  let workflowId: string;
  let seq = 0;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const newPlaybook = async (definition: unknown): Promise<string> => {
    seq += 1;
    const res = await admin()
      .post('/api/v1/playbooks')
      .send({ project_id: projectId, name: `playbook-${seq}`, definition });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const newCase = async (
    playbookId: string,
    upstreams?: Record<string, string>
  ): Promise<CaseBody> => {
    seq += 1;
    const res = await admin()
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: `case-${seq}`, ...(upstreams && { upstreams }) });
    expect(res.status).toBe(201);
    await flushPlaybookExecutions();
    return res.body as CaseBody;
  };

  const revisionOf = async (caseId: string): Promise<number | null> => {
    const res = await admin().get(`/api/v1/playbook-cases/${caseId}`);
    const profile = (res.body as CaseBody).nodes.find((node) => {
      return node.id === 'profile';
    });
    return profile?.inputs[0]?.revision ?? null;
  };

  const writeRegime = async (args: {
    caseId: string;
    value: string;
    token?: string;
  }) => {
    const res = await authenticatedTestClient(args.token ?? adminToken)
      .post(`/api/v1/playbook-cases/${args.caseId}/inputs`)
      .send({
        inputs: [
          {
            node_id: 'profile',
            name: 'regime',
            value: args.value,
            expected_revision: await revisionOf(args.caseId),
          },
        ],
      });
    await flushPlaybookExecutions();
    return res;
  };

  /** A run-as token, as the work named `work` would carry. */
  const runTokenFor = async (work: string) => {
    const me = await admin().get('/api/v1/users/me');
    return signRunToken({
      publicId: me.body.id,
      role: 'admin',
      projectPublicId: projectId,
      workPublicId: work,
    });
  };

  /** A filled company case and a dependent whose `review` is parked. */
  const boundPair = async () => {
    const company = await newCase(companyId);
    expect(
      (await writeRegime({ caseId: company.id, value: 'simples' })).status
    ).toBe(200);
    const dependent = await newCase(dependentId, { company: company.id });
    const executions = await admin().get(
      `/api/v1/playbook-cases/${dependent.id}/executions`
    );
    const parked = (
      executions.body.data as { node_id: string; id: string; run_id: string }[]
    ).find((execution) => {
      return execution.node_id === 'review';
    });
    expect(parked?.run_id).toMatch(/^task_/);
    return { company, dependent, parked: parked! };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'playbookupstreamselfwrite',
      policyActions: ['playbooks:CreatePlaybookCase'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const workflow = await admin()
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: 'upstream-review',
        states: [
          { name: 'open', initial: true },
          { name: 'done', terminal: true },
        ],
        transitions: [{ name: 'finish', from: ['open'], to: 'done' }],
      });
    expect(workflow.status).toBe(201);
    workflowId = workflow.body.id;

    companyId = await newPlaybook({ nodes: [PROFILE, APPROVAL] });
    dependentId = await newPlaybook(
      dependentDefinition({ upstreamId: companyId, workflowId })
    );
  });

  describe('POST /api/v1/playbook-cases/{case_id}/inputs', () => {
    test("refuses a write into the upstream case from the dependent's work", async () => {
      const { company, dependent, parked } = await boundPair();

      for (const work of [dependent.id, parked.id, parked.run_id]) {
        const res = await writeRegime({
          caseId: company.id,
          value: 'real',
          token: await runTokenFor(work),
        });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('PLAYBOOK_SELF_WRITE');
        expect(res.body.error.meta).toEqual({ work });
      }
    });

    test('refuses a write into a case upstream of the upstream', async () => {
      const { company, dependent } = await boundPair();
      const middleId = await newPlaybook(
        dependentDefinition({ upstreamId: dependentId, workflowId })
      );
      // The middle playbook reads the dependent's `profile`, an upstream node.
      const downstream = await newCase(middleId, { company: dependent.id });

      const res = await writeRegime({
        caseId: company.id,
        value: 'real',
        token: await runTokenFor(downstream.id),
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_SELF_WRITE');
    });

    test('admits a write from the work of a case bound to another upstream', async () => {
      const { company } = await boundPair();
      const { dependent: elsewhere } = await boundPair();

      const res = await writeRegime({
        caseId: company.id,
        value: 'real',
        token: await runTokenFor(elsewhere.id),
      });

      expect(res.status).toBe(200);
    });

    test('admits a write into a sibling dependent of the same upstream', async () => {
      const { company, dependent } = await boundPair();
      const sibling = await newCase(dependentId, { company: company.id });

      const res = await authenticatedTestClient(await runTokenFor(dependent.id))
        .post(`/api/v1/playbook-cases/${sibling.id}/upgrade`)
        .send({ version: 1 });

      expect(res.status).toBe(200);
    });

    test('admits a write from work that settled', async () => {
      const { company, dependent, parked } = await boundPair();
      const task = await admin()
        .post(`/api/v1/tasks/${parked.run_id}/transitions`)
        .send({ transition: 'finish' });
      expect(task.status).toBe(200);
      const execution = await pollUntil({
        read: async () => {
          const res = await admin().get(
            `/api/v1/playbook-cases/${dependent.id}/executions/${parked.id}`
          );
          return res.body as { status: string };
        },
        done: (body) => {
          return body.status !== 'running';
        },
      });
      expect(execution.status).toBe('completed');

      const res = await writeRegime({
        caseId: company.id,
        value: 'real',
        token: await runTokenFor(parked.id),
      });

      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/v1/playbook-cases/{case_id}/nodes/{node}/confirmation', () => {
    test("refuses a confirmation of the upstream case from the dependent's work", async () => {
      const { company, dependent } = await boundPair();

      const res = await authenticatedTestClient(await runTokenFor(dependent.id))
        .post(
          `/api/v1/playbook-cases/${company.id}/nodes/approval/confirmation`
        )
        .send({ decision: 'approve', expected_revisions: { regime: 1 } });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_SELF_WRITE');
    });
  });

  describe('POST /api/v1/playbook-cases/{case_id}/upgrade', () => {
    test("refuses an upgrade of the upstream case from the dependent's work", async () => {
      const { company, parked } = await boundPair();

      const res = await authenticatedTestClient(
        await runTokenFor(parked.run_id)
      )
        .post(`/api/v1/playbook-cases/${company.id}/upgrade`)
        .send({ version: 1 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_SELF_WRITE');
    });
  });
});
