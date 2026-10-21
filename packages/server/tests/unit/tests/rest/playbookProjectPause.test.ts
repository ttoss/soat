import { db } from 'src/db';
import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { createPlaybookTool } from '../../fixtures/playbookExecutors';
import { authenticatedTestClient } from '../../testClient';

/** One final collect node_id: written, it settles on its own input. */
const definitionOf = (toolId: string) => {
  return {
    nodes: [
      {
        id: 'answer',
        title: 'Answer',
        kind: 'collect',
        final: true,
        inputs: [
          {
            name: 'value',
            schema: { type: 'number' },
            required: true,
            source: 'manual',
          },
        ],
        transformations: [{ name: 'sheet', format: 'csv', tool: toolId }],
      },
    ],
  };
};

describe('Playbook cases under a project pause', () => {
  let adminToken: string;
  let projectId: string;
  let playbookId: string;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const pauseProject = async () => {
    const res = await asAdmin()
      .post(`/api/v1/projects/${projectId}/pause`)
      .send({ reason: 'spend anomaly' });
    expect(res.status).toBe(200);
  };

  const resumeProject = async () => {
    const res = await asAdmin().post(`/api/v1/projects/${projectId}/resume`);
    expect(res.status).toBe(200);
  };

  const newCase = async (): Promise<string> => {
    seq += 1;
    const res = await asAdmin()
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: `paused-${seq}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const write = async (caseId: string, value: number) => {
    const res = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: [
          { node_id: 'answer', name: 'value', value, expected_revision: null },
        ],
      });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
  };

  const readCase = async (caseId: string) => {
    const res = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  const idsIn = async (status: string): Promise<string[]> => {
    const res = await asAdmin().get(
      `/api/v1/playbook-cases?project_id=${projectId}&automation_status=${status}&limit=100`
    );
    expect(res.status).toBe(200);
    return res.body.data.map((row: { id: string }) => {
      return row.id;
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'pbkprojpause',
      policyActions: [],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    const toolId = await createPlaybookTool({
      token: adminToken,
      projectId,
      name: 'sheet-tool',
    });
    const res = await asAdmin()
      .post('/api/v1/playbooks')
      .send({
        project_id: projectId,
        name: 'paused-project',
        definition: definitionOf(toolId),
      });
    expect(res.status).toBe(201);
    playbookId = res.body.id;
  });

  afterEach(async () => {
    await db.Project.update(
      { pausedAt: null, pauseReason: null },
      { where: { publicId: projectId } }
    );
  });

  test('a case reads paused and lists as paused while its project is', async () => {
    const caseId = await newCase();
    await pauseProject();
    await write(caseId, 3);

    const held = await readCase(caseId);
    expect(held).toMatchObject({
      automation_status: 'paused',
      pause_requested_at: null,
    });
    expect(await idsIn('paused')).toContain(caseId);
    expect(await idsIn('running')).not.toContain(caseId);
    expect(await idsIn('idle')).not.toContain(caseId);
  });

  test('the project resume runs what its pause held', async () => {
    const caseId = await newCase();
    await pauseProject();
    await write(caseId, 4);

    await resumeProject();
    await flushPlaybookExecutions();

    const resumed = await readCase(caseId);
    expect(resumed.automation_status).toBe('idle');
    expect(resumed.nodes[0].output.value).toEqual({ value: 4 });
  });

  test('running a node returns 409 PROJECT_PAUSED', async () => {
    const caseId = await newCase();
    await pauseProject();

    const res = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/nodes/answer/run`)
      .send({ wait: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROJECT_PAUSED');
    expect(res.body.error.meta.pause_reason).toBe('spend anomaly');
  });

  test('exporting a node returns 409 PROJECT_PAUSED and records nothing', async () => {
    const caseId = await newCase();
    await write(caseId, 5);
    await pauseProject();

    const res = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/nodes/answer/exports`)
      .send({ wait: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROJECT_PAUSED');
    const exports = await asAdmin().get(
      `/api/v1/playbook-cases/${caseId}/exports`
    );
    expect(exports.body.data).toEqual([]);
  });

  test('resuming a case returns 409 PROJECT_PAUSED and keeps its pause', async () => {
    const caseId = await newCase();
    const paused = await asAdmin().post(
      `/api/v1/playbook-cases/${caseId}/pause`
    );
    expect(paused.status).toBe(200);
    await pauseProject();

    const res = await asAdmin().post(`/api/v1/playbook-cases/${caseId}/resume`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROJECT_PAUSED');
    expect((await readCase(caseId)).pause_requested_at).toBe(
      paused.body.pause_requested_at
    );
  });
});
