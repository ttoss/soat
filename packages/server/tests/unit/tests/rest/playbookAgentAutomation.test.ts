import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  textCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

/**
 * An agent executor names its generation on the execution while the turn
 * runs, so the case's automation tells a turn in flight from a park by the
 * executor, not by the `run_id`.
 */
describe('Playbook case automation while an agent node runs', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let playbookId: string;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin()
      .post(path)
      .send({ project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const listed = async (status: string) => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/playbook-cases?project_id=${projectId}&automation_status=${status}&limit=100`
    );
    expect(res.status).toBe(200);
    return res.body.data.map((row: { id: string }) => {
      return row.id;
    });
  };

  /** Holds the next completion open until the returned `release` is called. */
  const holdTurn = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    stub.reply(async () => {
      entered();
      await held;
      return textCompletion('Simples Nacional');
    });
    return { started, release };
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();
    const setup = await setupProjectWithUsers({
      prefix: 'playbookagentauto',
      policyActions: [
        'playbooks:GetPlaybookCase',
        'playbooks:ListPlaybookCases',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const providerId = await create('/api/v1/ai-providers', {
      name: 'agent-auto-provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    const agentId = await create('/api/v1/agents', {
      ai_provider_id: providerId,
      name: 'agent-auto-agent',
    });
    playbookId = await create('/api/v1/playbooks', {
      name: 'agent-auto',
      definition: {
        nodes: [
          {
            id: 'essay',
            title: 'Essay',
            kind: 'execute',
            inputs: [
              {
                name: 'topic',
                schema: { type: 'string' },
                required: true,
                source: 'manual',
              },
            ],
            executor: { type: 'agent', id: agentId },
          },
        ],
      },
    });
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('GET /api/v1/playbook-cases/{case_id}', () => {
    test('reads running while the turn runs, then idle', async () => {
      seq += 1;
      const created = await asAdmin()
        .post(`/api/v1/playbooks/${playbookId}/cases`)
        .send({ subject: `essay-${seq}` });
      expect(created.status).toBe(201);
      const caseId = created.body.id as string;
      const turn = holdTurn();
      try {
        const written = await asAdmin()
          .post(`/api/v1/playbook-cases/${caseId}/inputs`)
          .send({
            inputs: [
              {
                node_id: 'essay',
                name: 'topic',
                value: 'taxes',
                expected_revision: null,
              },
            ],
          });
        expect(written.status).toBe(200);
        await turn.started;

        const executions = await asAdmin().get(
          `/api/v1/playbook-cases/${caseId}/executions?limit=100`
        );
        expect(executions.body.data[0]).toMatchObject({
          status: 'running',
          run_id: expect.stringMatching(/^gen_/),
        });
        const single = await authenticatedTestClient(userToken).get(
          `/api/v1/playbook-cases/${caseId}`
        );
        expect(single.status).toBe(200);
        expect(single.body.automation_status).toBe('running');
        expect(await listed('running')).toContain(caseId);
        expect(await listed('waiting')).not.toContain(caseId);
      } finally {
        turn.release();
        await flushPlaybookExecutions();
        stub.reply();
      }

      const done = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}`
      );
      expect(done.body.automation_status).toBe('idle');
    });
  });
});
