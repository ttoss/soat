import { db } from 'src/db';
import { drainEvalQueueOnce } from 'src/lib/evaluationWorker';
import { flushProjectResumes } from 'src/lib/projectPauseActions';
import { flushTaskAutomations } from 'src/lib/tasks';
import { fireDueTriggers } from 'src/lib/triggerScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

/**
 * What a project pause does to work already in motion: the runs, tasks,
 * schedules, event triggers and eval items that no request starts.
 */
describe('Project pause — work in motion', () => {
  let adminToken: string;
  let projectId: string;
  let agentId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const pauseProject = async (reason = 'kill switch') => {
    const res = await asAdmin()
      .post(`/api/v1/projects/${projectId}/pause`)
      .send({ reason });
    expect(res.status).toBe(200);
  };

  const resumeProject = async () => {
    const res = await asAdmin().post(`/api/v1/projects/${projectId}/resume`);
    expect(res.status).toBe(200);
    await flushProjectResumes();
  };

  const completed = (id: string) => {
    return {
      id,
      traceId: `trc_${id}`,
      status: 'completed' as const,
      output: { model: 'm', content: 'done', finishReason: 'stop' },
    };
  };

  beforeAll(async () => {
    process.env.EVAL_WORKER_DISABLED = 'true';

    const setup = await setupProjectWithUsers({
      prefix: 'pausedrv',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Drivers Provider',
      provider: 'ollama',
      default_model: 'llama3.2',
    });
    agentId = (
      await asAdmin().post('/api/v1/agents').send({
        project_id: projectId,
        name: 'Drivers Agent',
        ai_provider_id: provider.body.id,
      })
    ).body.id;
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await flushTaskAutomations();
    await db.Project.update(
      { pausedAt: null, pauseReason: null },
      { where: { publicId: projectId } }
    );
  });

  afterAll(() => {
    delete process.env.EVAL_WORKER_DISABLED;
  });

  describe('orchestration runs', () => {
    const getRun = async (id: string) => {
      return (await asAdmin().get(`/api/v1/orchestration-runs/${id}`)).body;
    };

    const pollRun = async (args: { runId: string; status: string }) => {
      for (let i = 0; i < 200; i += 1) {
        const run = await getRun(args.runId);
        if (run.status === args.status) return run;
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      throw new Error(
        `run ${args.runId} never reached ${args.status}: ${JSON.stringify(await getRun(args.runId))}`
      );
    };

    const startSleepingRun = async (): Promise<string> => {
      const orch = await asAdmin()
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: `Sleeper ${Math.random()}`,
          nodes: [
            { id: 'delay', type: 'delay', duration: '1h' },
            { id: 'after', type: 'transform', expression: 'done' },
          ],
          edges: [{ from: 'delay', to: 'after' }],
        });
      expect(orch.status).toBe(201);

      const run = await asAdmin()
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orch.body.id, input: {} });
      expect(run.status).toBe(201);
      const runId = run.body.id as string;
      await pollRun({ runId, status: 'sleeping' });
      return runId;
    };

    test('a sleeping run is parked on the project pause and handed back on resume', async () => {
      const runId = await startSleepingRun();

      await pauseProject('spend anomaly');

      const parked = await getRun(runId);
      expect(parked.status).toBe('awaiting_input');
      expect(parked.required_action.type).toBe('paused');
      expect(parked.pause_reason).toBe('spend anomaly');
      expect(parked.pause_requested_at).not.toBeNull();

      await resumeProject();

      const resumed = await getRun(runId);
      expect(resumed.status).toBe('sleeping');
      expect(resumed.pause_requested_at).toBeNull();
      expect(resumed.pause_reason).toBeNull();
    });

    test('a run cannot be resumed on its own while the project is paused', async () => {
      const runId = await startSleepingRun();
      await pauseProject();

      const res = await asAdmin().post(
        `/api/v1/orchestration-runs/${runId}/resume`
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROJECT_PAUSED');
    });

    test('a run an operator paused first keeps its own pause', async () => {
      const runId = await startSleepingRun();
      const own = await asAdmin()
        .post(`/api/v1/orchestration-runs/${runId}/pause`)
        .send({ reason: 'operator hold' });
      expect(own.status).toBe(200);

      await pauseProject();
      await resumeProject();

      const run = await getRun(runId);
      expect(run.status).toBe('awaiting_input');
      expect(run.pause_reason).toBe('operator hold');
    });

    test('a run the sweep missed is flagged at its checkpoint', async () => {
      const runId = await startSleepingRun();
      // The pause lands on the project without the sweep, the shape of a run
      // written while the sweep was already past it.
      await db.Project.update(
        { pausedAt: new Date(), pauseReason: 'late' },
        { where: { publicId: projectId } }
      );
      await db.OrchestrationRun.update(
        { wakeAt: new Date(Date.now() - 1000) },
        { where: { publicId: runId } }
      );
      const { wakeDueRuns } = await import('src/lib/orchestrationScheduler');
      await wakeDueRuns({ now: new Date() });

      const parked = await pollRun({ runId, status: 'awaiting_input' });
      expect(parked.required_action.type).toBe('paused');
      expect(parked.pause_reason).toBe('late');

      await resumeProject();
      expect((await getRun(runId)).pause_requested_at).toBeNull();
    });
  });

  describe('tasks', () => {
    let workflowId: string;

    beforeAll(async () => {
      workflowId = (
        await asAdmin()
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: 'pause-drivers',
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
            transitions: [
              { name: 'to_writing', from: ['idea'], to: 'writing' },
            ],
          })
      ).body.id;
    });

    const createTask = async (): Promise<string> => {
      const res = await asAdmin()
        .post('/api/v1/tasks')
        .send({ project_id: projectId, workflow_id: workflowId, title: 't' });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    const transition = async (taskId: string) => {
      const res = await asAdmin()
        .post(`/api/v1/tasks/${taskId}/transitions`)
        .send({ transition: 'to_writing' });
      expect(res.status).toBe(200);
      await flushTaskAutomations();
    };

    const getTask = async (id: string) => {
      return (await asAdmin().get(`/api/v1/tasks/${id}`)).body;
    };

    test('an open task is paused, suppresses its dispatch, and dispatches on resume', async () => {
      const taskId = await createTask();
      await pauseProject('board frozen');

      const paused = await getTask(taskId);
      expect(paused.pause_requested_at).not.toBeNull();
      expect(paused.pause_reason).toBe('board frozen');

      await transition(taskId);
      expect(mockCreateGeneration).not.toHaveBeenCalled();
      expect((await getTask(taskId)).automation_status).toBe('paused');

      mockCreateGeneration.mockResolvedValueOnce(completed('gen_task_resume'));
      await resumeProject();
      await flushTaskAutomations();

      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
      expect((await getTask(taskId)).pause_requested_at).toBeNull();
    });

    test('a task cannot be resumed on its own while the project is paused', async () => {
      const taskId = await createTask();
      await pauseProject();

      const res = await asAdmin().post(`/api/v1/tasks/${taskId}/resume`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROJECT_PAUSED');
    });

    test('a task the sweep missed is flagged at its dispatch', async () => {
      const taskId = await createTask();
      await db.Project.update(
        { pausedAt: new Date(), pauseReason: 'late' },
        { where: { publicId: projectId } }
      );

      await transition(taskId);

      expect(mockCreateGeneration).not.toHaveBeenCalled();
      const flagged = await getTask(taskId);
      expect(flagged.automation_status).toBe('paused');
      expect(flagged.pause_reason).toBe('late');

      mockCreateGeneration.mockResolvedValueOnce(completed('gen_task_late'));
      await resumeProject();
      await flushTaskAutomations();
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
    });
  });

  describe('triggers', () => {
    const createTrigger = async (body: Record<string, unknown>) => {
      const res = await asAdmin()
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: `trg-${Math.random()}`,
          target_type: 'agent',
          target_id: agentId,
          ...body,
        });
      expect(res.status).toBe(201);
      return (await db.Trigger.findOne({ where: { publicId: res.body.id } }))!;
    };

    test('a due schedule is not fired while paused, and resume re-anchors it', async () => {
      const trigger = await createTrigger({
        type: 'schedule',
        cron: '0 8 * * *',
      });
      const dueAt = new Date(Date.now() - 60_000);
      await trigger.update({ nextFireAt: dueAt });
      await pauseProject();

      await fireDueTriggers({ now: new Date() });

      await trigger.reload();
      expect(trigger.nextFireAt).toEqual(dueAt);
      expect(
        await db.TriggerFiring.count({ where: { triggerId: trigger.id } })
      ).toBe(0);

      await resumeProject();

      await trigger.reload();
      expect((trigger.nextFireAt as Date).getTime()).toBeGreaterThan(
        Date.now()
      );
    });

    test('an event trigger records a refused firing while paused', async () => {
      const trigger = await createTrigger({
        type: 'event',
        event_pattern: 'agents.updated',
      });
      await pauseProject('event storm');

      const updated = await asAdmin()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ instructions: 'poke' });
      expect(updated.status).toBe(200);

      const firing = await (async () => {
        for (let i = 0; i < 500; i += 1) {
          const row = await db.TriggerFiring.findOne({
            where: { triggerId: trigger.id },
          });
          if (row?.status === 'failed') return row;
          await new Promise((resolve) => {
            setImmediate(resolve);
          });
        }
        throw new Error('no refused firing recorded');
      })();
      expect(firing.error).toMatchObject({
        code: 'PROJECT_PAUSED',
        meta: { pause_reason: 'event storm' },
      });
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });
  });

  describe('eval runs', () => {
    test('queued items wait while paused and run after resume', async () => {
      const dataset = await asAdmin()
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: 'drivers-dataset' });
      await asAdmin()
        .post(`/api/v1/datasets/${dataset.body.id}/items`)
        .send({ input: [{ role: 'user', content: 'one' }] });
      const evaluation = await asAdmin()
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'drivers-eval',
          agent_id: agentId,
          dataset_id: dataset.body.id,
          scorers: [{ type: 'contains', value: 'done' }],
        });
      const run = await asAdmin()
        .post(`/api/v1/evals/${evaluation.body.id}/runs`)
        .send({ wait: false });
      expect(run.status).toBe(201);
      expect(run.body.status).toBe('queued');

      await pauseProject();
      expect(await drainEvalQueueOnce()).toBe(0);
      expect(mockCreateGeneration).not.toHaveBeenCalled();

      await resumeProject();
      mockCreateGeneration.mockResolvedValueOnce(completed('gen_eval_resume'));
      expect(await drainEvalQueueOnce()).toBe(1);
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
    });
  });
});
