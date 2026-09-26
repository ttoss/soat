import { db } from 'src/db';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Project pause', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let aiProviderId: string;
  let agentId: string;
  let otherAgentId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const pause = (id: string, body: object = {}) => {
    return authenticatedTestClient(userToken)
      .post(`/api/v1/projects/${id}/pause`)
      .send(body);
  };

  const resume = (id: string) => {
    return authenticatedTestClient(userToken).post(
      `/api/v1/projects/${id}/resume`
    );
  };

  const createAgent = async (args: { project: string; provider: string }) => {
    const res = await asAdmin().post('/api/v1/agents').send({
      project_id: args.project,
      name: 'Pause Agent',
      ai_provider_id: args.provider,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createProvider = async (project: string) => {
    const res = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: project,
      name: 'Pause Provider',
      provider: 'ollama',
      default_model: 'llama3.2',
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** Captures the bus events of one type emitted while `fn` runs. */
  const captureEvents = async (args: {
    type: string;
    fn: () => Promise<void>;
  }): Promise<SoatEvent[]> => {
    const seen: SoatEvent[] = [];
    const handler = (event: SoatEvent) => {
      if (event.type === args.type) seen.push(event);
    };
    eventBus.on('soat:event', handler);
    try {
      await args.fn();
    } finally {
      eventBus.off('soat:event', handler);
    }
    return seen;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'projpause',
      policyActions: [
        'projects:GetProject',
        'projects:PauseProject',
        'projects:ResumeProject',
      ],
      createOtherProject: true,
      createNoPermUser: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    aiProviderId = await createProvider(projectId);
    agentId = await createAgent({ project: projectId, provider: aiProviderId });
    otherAgentId = await createAgent({
      project: otherProjectId,
      provider: await createProvider(otherProjectId),
    });
  });

  afterEach(async () => {
    await db.Project.update(
      { pausedAt: null, pauseReason: null },
      { where: { publicId: [projectId, otherProjectId] } }
    );
  });

  describe('POST /api/v1/projects/:project_id/pause', () => {
    test('pauses the project and records the reason', async () => {
      const res = await pause(projectId, { reason: 'anomaly detected' });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(projectId);
      expect(res.body.paused_at).not.toBeNull();
      expect(res.body.pause_reason).toBe('anomaly detected');

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(read.body.paused_at).toBe(res.body.paused_at);
      expect(read.body.pause_reason).toBe('anomaly detected');
    });

    test('a running project reads as not paused', async () => {
      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(read.status).toBe(200);
      expect(read.body.paused_at).toBeNull();
      expect(read.body.pause_reason).toBeNull();
    });

    test('the reason is optional', async () => {
      const res = await pause(projectId);

      expect(res.status).toBe(200);
      expect(res.body.paused_at).not.toBeNull();
      expect(res.body.pause_reason).toBeNull();
    });

    test('pausing a paused project answers it unchanged', async () => {
      const first = await pause(projectId, { reason: 'first' });
      const second = await pause(projectId, { reason: 'second' });

      expect(second.status).toBe(200);
      expect(second.body.paused_at).toBe(first.body.paused_at);
      expect(second.body.pause_reason).toBe('first');
    });

    test('emits projects.paused once', async () => {
      const events = await captureEvents({
        type: 'projects.paused',
        fn: async () => {
          await pause(projectId, { reason: 'evented' });
          await pause(projectId, { reason: 'evented again' });
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0].resourceType).toBe('project');
      expect(events[0].resourceId).toBe(projectId);
      expect(events[0].projectPublicId).toBe(projectId);
      expect(events[0].data).toMatchObject({
        project: { id: projectId, pause_reason: 'evented' },
      });
    });

    test('a reason over 256 characters is refused', async () => {
      const res = await pause(projectId, { reason: 'x'.repeat(257) });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated is 401', async () => {
      const res = await testClient
        .post(`/api/v1/projects/${projectId}/pause`)
        .send({});
      expect(res.status).toBe(401);
    });

    test('a caller without projects:PauseProject is 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/projects/${projectId}/pause`)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('an unknown project is 404', async () => {
      const res = await asAdmin()
        .post('/api/v1/projects/proj_doesnotexist0000000/pause')
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('POST /api/v1/projects/:project_id/resume', () => {
    test('clears the pause', async () => {
      await pause(projectId, { reason: 'to be lifted' });

      const res = await resume(projectId);

      expect(res.status).toBe(200);
      expect(res.body.paused_at).toBeNull();
      expect(res.body.pause_reason).toBeNull();
    });

    test('emits projects.resumed', async () => {
      await pause(projectId);
      const events = await captureEvents({
        type: 'projects.resumed',
        fn: async () => {
          await resume(projectId);
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0].resourceId).toBe(projectId);
    });

    test('a project that is not paused is 409 PROJECT_NOT_PAUSED', async () => {
      const res = await resume(projectId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROJECT_NOT_PAUSED');
    });

    test('unauthenticated is 401', async () => {
      const res = await testClient.post(`/api/v1/projects/${projectId}/resume`);
      expect(res.status).toBe(401);
    });

    test('a caller without projects:ResumeProject is 403', async () => {
      await pause(projectId);
      const res = await authenticatedTestClient(noPermToken).post(
        `/api/v1/projects/${projectId}/resume`
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('starts refused while paused', () => {
    const expectPaused = (res: {
      status: number;
      body: { error: { code: string; meta?: unknown } };
    }) => {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROJECT_PAUSED');
      expect(res.body.error.meta).toMatchObject({
        project_id: projectId,
        pause_reason: 'kill switch',
      });
    };

    beforeEach(async () => {
      const res = await pause(projectId, { reason: 'kill switch' });
      expect(res.status).toBe(200);
    });

    test('an agent generation', async () => {
      const res = await asAdmin()
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hi' }] });

      expectPaused(res);
      expect(await db.Generation.count()).toBe(0);
    });

    test('a background agent generation', async () => {
      const res = await asAdmin()
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hi' }] });

      expectPaused(res);
    });

    // No provider answers in the suite, so a generation that is admitted fails
    // at the provider instead — which is exactly what "not refused" looks like.
    test('an unknown agent is still a 404', async () => {
      const res = await asAdmin()
        .post('/api/v1/agents/agt_doesnotexist0000/generate?wait=true')
        .send({ messages: [{ role: 'user', content: 'hi' }] });

      expect(res.status).toBe(404);
    });

    test('another project is not refused', async () => {
      const res = await asAdmin()
        .post(`/api/v1/agents/${otherAgentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hi' }] });

      expect(res.body.error?.code).not.toBe('PROJECT_PAUSED');
    });

    test('a session generation', async () => {
      const session = await asAdmin()
        .post('/api/v1/sessions')
        .send({ agent_id: agentId });
      expect(session.status).toBe(201);

      const message = await asAdmin()
        .post(`/api/v1/sessions/${session.body.id}/messages`)
        .send({ message: 'hi' });
      expect(message.status).toBe(201);

      const res = await asAdmin().post(
        `/api/v1/sessions/${session.body.id}/generate?wait=true`
      );

      expectPaused(res);
    });

    test('an orchestration run', async () => {
      const orch = await asAdmin()
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'Refused Run',
          nodes: [{ id: 'a', type: 'transform', expression: 'x' }],
          edges: [],
        });
      expect(orch.status).toBe(201);

      const res = await asAdmin()
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orch.body.id, input: {} });

      expectPaused(res);
      expect(
        await db.OrchestrationRun.count({
          include: [
            {
              model: db.Orchestration,
              as: 'orchestration',
              where: { publicId: orch.body.id },
            },
          ],
        })
      ).toBe(0);
    });

    test('an eval run', async () => {
      const dataset = await asAdmin()
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: 'pause-dataset' });
      await asAdmin()
        .post(`/api/v1/datasets/${dataset.body.id}/items`)
        .send({ input: [{ role: 'user', content: 'hi' }] });
      const evaluation = await asAdmin()
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'pause-eval',
          agent_id: agentId,
          dataset_id: dataset.body.id,
          scorers: [{ type: 'contains', value: 'x' }],
        });
      expect(evaluation.status).toBe(201);

      const res = await asAdmin()
        .post(`/api/v1/evals/${evaluation.body.id}/runs`)
        .send({});

      expectPaused(res);
    });

    test('a tool call', async () => {
      const tool = await asAdmin()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'pausedTool',
          type: 'http',
          parameters: { type: 'object', properties: {} },
          execute: { url: 'http://127.0.0.1:9/never', method: 'POST' },
        });
      expect(tool.status).toBe(201);

      const res = await asAdmin()
        .post(`/api/v1/tools/${tool.body.id}/call`)
        .send({ input: {} });

      expectPaused(res);
    });

    test('a manual trigger fire', async () => {
      const trigger = await asAdmin().post('/api/v1/triggers').send({
        project_id: projectId,
        name: 'paused-manual',
        type: 'manual',
        target_type: 'agent',
        target_id: agentId,
      });
      expect(trigger.status).toBe(201);

      const res = await asAdmin()
        .post(`/api/v1/triggers/${trigger.body.id}/fire`)
        .send({ input: { message: 'hi' } });

      expectPaused(res);
      const row = await db.Trigger.findOne({
        where: { publicId: trigger.body.id },
      });
      expect(
        await db.TriggerFiring.count({ where: { triggerId: row!.id } })
      ).toBe(0);
    });

    test('a chat completion against the project provider', async () => {
      const res = await asAdmin()
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [{ role: 'user', content: 'hi' }],
        });

      expectPaused(res);
    });

    test('reads and configuration writes still work', async () => {
      const read = await asAdmin().get(`/api/v1/agents/${agentId}`);
      expect(read.status).toBe(200);

      const write = await asAdmin()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ instructions: 'still editable' });
      expect(write.status).toBe(200);
    });

    test('generation is admitted again after resume', async () => {
      await resume(projectId);

      const res = await asAdmin()
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hi' }] });

      expect(res.body.error?.code).not.toBe('PROJECT_PAUSED');
    });
  });
});
