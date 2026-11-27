import { drainEvalQueueOnce } from 'src/lib/evaluationWorker';
import { flushPlaybookExecutions } from 'src/lib/playbookCascade';
import { flushTaskAutomations } from 'src/lib/tasks';

import {
  type AdmissionService,
  ADMIT,
  DOWN_URL,
  REFUSAL,
  startAdmissionService,
} from '../../fixtures/admissionService';
import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { testGrant } from '../../fixtures/bootstrap';
import { createPlaybookCase } from '../../fixtures/playbookCase';
import { pollUntil } from '../../fixtures/poll';

/**
 * Work the runtime does on its own asks admission at each step: a refusal
 * stops the step, and what it does to the work depends on the kind of work.
 */
const GENERATION = 'agents:CreateAgentGeneration';
const REFUSED_REASON = 'PLAN_LIMIT_REACHED: The plan allows 3 of these.';

let service: AdmissionService;
let turn: AgentToolTurn;
let agentId: string;
let grant: string[];

const hello = [{ role: 'user', content: 'hello' }];

const createTrigger = async () => {
  const res = await turn
    .api()
    .post('/api/v1/triggers')
    .send({
      project_id: turn.projectId,
      name: turn.unique('work'),
      type: 'webhook',
      target_type: 'agent',
      target_id: agentId,
      policy_ids: grant,
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const fire = async (triggerId: string) => {
  const res = await turn
    .api()
    .post(`/api/v1/triggers/${triggerId}/fire`)
    .send({ input: { message: 'hello' } });
  expect(res.status).toBe(200);
  return res.body;
};

beforeAll(async () => {
  process.env.EVAL_WORKER_DISABLED = 'true';
  service = await startAdmissionService();
  turn = await startAgentToolTurn({ prefix: 'admissionwork' });
  agentId = await turn.createAgent({});
  grant = await testGrant({ token: turn.adminToken });
});

beforeEach(() => {
  service.declare({ actions: [GENERATION] });
});

afterEach(async () => {
  await flushTaskAutomations();
  await flushPlaybookExecutions();
  service.undeclare();
});

afterAll(async () => {
  delete process.env.EVAL_WORKER_DISABLED;
  await turn.close();
  await service.close();
});

describe('admission — a step of internal work', () => {
  describe('a trigger firing', () => {
    test('asks about the generation it starts, as a step', async () => {
      const firing = await fire(await createTrigger());

      expect(firing.status).toBe('completed');
      expect(service.asked).toHaveLength(1);
      expect(service.asked[0].signed).toBe(true);
      expect(service.asked[0].body).toMatchObject({
        action: GENERATION,
        project_id: turn.projectId,
        resource_type: 'agent',
        resource_id: agentId,
        body: null,
      });
    });

    test('is recorded refused and generates nothing', async () => {
      const triggerId = await createTrigger();
      service.reply = REFUSAL;
      const before = turn.model.requests.length;

      const firing = await fire(triggerId);

      expect(firing.status).toBe('failed');
      expect(firing.error.code).toBe('PLAN_LIMIT_REACHED');
      expect(turn.model.requests).toHaveLength(before);
    });
  });

  describe('on_unavailable', () => {
    test('refuses an unanswered step by default', async () => {
      service.declare({ actions: [GENERATION], url: DOWN_URL });

      const firing = await fire(await createTrigger());

      expect(firing.status).toBe('failed');
      expect(firing.error.code).toBe('ADMISSION_UNAVAILABLE');
    });

    test('allow passes an unanswered step', async () => {
      service.declare({
        actions: [GENERATION],
        url: DOWN_URL,
        onUnavailable: 'allow',
      });

      const firing = await fire(await createTrigger());

      expect(firing.status).toBe('completed');
    });

    test('allow leaves a REST write fail-closed', async () => {
      service.declare({
        actions: [GENERATION],
        url: DOWN_URL,
        onUnavailable: 'allow',
      });

      const res = await turn
        .api()
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: hello });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('ADMISSION_UNAVAILABLE');
    });
  });

  describe('an orchestration run', () => {
    const startRun = async () => {
      const orchestration = await turn
        .api()
        .post('/api/v1/orchestrations')
        .send({
          project_id: turn.projectId,
          name: turn.unique('steps'),
          nodes: [
            {
              id: 'ask',
              type: 'agent',
              agent_id: agentId,
              input_mapping: { prompt: 'hello' },
            },
          ],
          edges: [],
        });
      expect(orchestration.status).toBe(201);
      const run = await turn
        .api()
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestration.body.id, wait: true });
      expect(run.status).toBe(201);
      return run.body;
    };

    test('parks on the operator pause, the refusal its reason, and resumes', async () => {
      service.reply = REFUSAL;

      const parked = await startRun();

      expect(parked.status).toBe('awaiting_input');
      expect(parked.required_action.type).toBe('paused');
      expect(parked.pause_reason).toBe(REFUSED_REASON);

      service.reply = ADMIT;
      const resumed = await turn
        .api()
        .post(`/api/v1/orchestration-runs/${parked.id}/resume`);
      expect(resumed.status).toBe(200);
      const settled = await pollUntil({
        read: async () => {
          return (
            await turn.api().get(`/api/v1/orchestration-runs/${parked.id}`)
          ).body;
        },
        done: (run) => {
          return run.status === 'completed';
        },
      });
      expect(settled.pause_reason).toBeNull();
    });
  });

  describe("a task's automation", () => {
    test('pauses, the refusal its reason, and dispatches on resume', async () => {
      const workflow = await turn
        .api()
        .post('/api/v1/workflows')
        .send({
          project_id: turn.projectId,
          name: turn.unique('flow'),
          states: [
            { name: 'idea', initial: true },
            {
              name: 'writing',
              on_enter: {
                dispatch: {
                  kind: 'agent',
                  agent_id: agentId,
                  input_mapping: { prompt: 'write' },
                },
              },
            },
          ],
          transitions: [{ name: 'to_writing', from: ['idea'], to: 'writing' }],
        });
      expect(workflow.status).toBe(201);
      const task = await turn.api().post('/api/v1/tasks').send({
        project_id: turn.projectId,
        workflow_id: workflow.body.id,
        title: 't',
      });
      expect(task.status).toBe(201);
      service.reply = REFUSAL;

      await turn
        .api()
        .post(`/api/v1/tasks/${task.body.id}/transitions`)
        .send({ transition: 'to_writing' });
      await flushTaskAutomations();

      const paused = (await turn.api().get(`/api/v1/tasks/${task.body.id}`))
        .body;
      expect(paused.pause_requested_at).not.toBeNull();
      expect(paused.pause_reason).toBe(REFUSED_REASON);
      expect(paused.automation_status).toBe('paused');

      service.reply = ADMIT;
      const resumed = await turn
        .api()
        .post(`/api/v1/tasks/${task.body.id}/resume`);
      expect(resumed.status).toBe(200);
      await flushTaskAutomations();
      const after = (await turn.api().get(`/api/v1/tasks/${task.body.id}`))
        .body;
      expect(after.pause_requested_at).toBeNull();
      expect(after.automation_status).toBe('completed');
    });
  });

  describe('a playbook case', () => {
    test('pauses, its execution queued with the refusal, and runs it on resume', async () => {
      const playbook = await turn
        .api()
        .post('/api/v1/playbooks')
        .send({
          project_id: turn.projectId,
          policy_ids: grant,
          name: turn.unique('book'),
          definition: {
            nodes: [
              {
                id: 'essay',
                title: 'Essay',
                kind: 'execute',
                inputs: [],
                executor: { type: 'agent', id: agentId },
              },
            ],
          },
        });
      expect(playbook.status).toBe(201);
      service.reply = REFUSAL;

      const created = await createPlaybookCase({
        client: turn.api(),
        playbookId: playbook.body.id,
        body: { subject: turn.unique('case') },
      });
      expect(created.status).toBe(201);
      const caseId = created.body.id as string;

      const paused = (await turn.api().get(`/api/v1/playbook-cases/${caseId}`))
        .body;
      expect(paused.pause_requested_at).not.toBeNull();
      const executions = (
        await turn.api().get(`/api/v1/playbook-cases/${caseId}/executions`)
      ).body.data;
      expect(executions).toHaveLength(1);
      expect(executions[0].status).toBe('queued');
      expect(executions[0].error.code).toBe('PLAN_LIMIT_REACHED');

      service.reply = ADMIT;
      const resumed = await turn
        .api()
        .post(`/api/v1/playbook-cases/${caseId}/resume`);
      expect(resumed.status).toBe(200);
      await flushPlaybookExecutions();
      const [settled] = (
        await turn.api().get(`/api/v1/playbook-cases/${caseId}/executions`)
      ).body.data;
      expect(settled.status).toBe('completed');
      expect(settled.error).toBeNull();
    });
  });

  describe('an eval run', () => {
    test('stops, failed with the refusal', async () => {
      const dataset = await turn
        .api()
        .post('/api/v1/datasets')
        .send({ project_id: turn.projectId, name: turn.unique('set') });
      for (const content of ['one', 'two']) {
        await turn
          .api()
          .post(`/api/v1/datasets/${dataset.body.id}/items`)
          .send({ input: [{ role: 'user', content }] });
      }
      const evaluation = await turn
        .api()
        .post('/api/v1/evals')
        .send({
          policy_ids: grant,
          project_id: turn.projectId,
          name: turn.unique('eval'),
          agent_id: agentId,
          dataset_id: dataset.body.id,
          scorers: [{ type: 'contains', name: 'contains', value: 'x' }],
        });
      expect(evaluation.status).toBe(201);
      const run = await turn
        .api()
        .post(`/api/v1/evals/${evaluation.body.id}/runs`)
        .send({ wait: false });
      expect(run.status).toBe(201);
      service.reply = REFUSAL;

      await drainEvalQueueOnce();

      const stopped = (
        await turn
          .api()
          .get(`/api/v1/evals/${evaluation.body.id}/runs/${run.body.id}`)
      ).body;
      expect(stopped.status).toBe('failed');
      expect(stopped.error.code).toBe('PLAN_LIMIT_REACHED');
    });
  });
});
