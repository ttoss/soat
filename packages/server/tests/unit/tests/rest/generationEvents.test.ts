import { droppedEventCount, eventBus, type SoatEvent } from 'src/lib/eventBus';
import * as generationsModule from 'src/lib/generations';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  providerFailure,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

/**
 * Every `*.generation.*` lifecycle event names the generation and carries its
 * record exactly as `GET /api/v1/generations/{generation_id}` answers it, so a
 * subscriber reads one shape whichever transport ran the turn.
 */
describe('generation lifecycle events', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let clientToolId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createAgent = async (args: {
    name: string;
    toolIds?: string[];
  }): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: args.name,
        tool_bindings: (args.toolIds ?? []).map((toolId) => {
          return { tool_id: toolId };
        }),
        max_steps: 3,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generate = (agentId: string) => {
    return asAdmin()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'go' }] });
  };

  const createSession = async (agentId: string): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, auto_generate: false });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generateInSession = async (sessionId: string) => {
    const message = await asAdmin()
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .send({ message: 'go' });
    expect(message.status).toBe(201);
    return asAdmin().post(`/api/v1/sessions/${sessionId}/generate?wait=true`);
  };

  /**
   * Runs `action` with a listener collecting the named event, and resolves the
   * one emitted for `generationId` once it arrives.
   */
  const captureEvents = async (args: {
    type: string;
    action: () => Promise<string>;
  }): Promise<{ generationId: string; events: SoatEvent[] }> => {
    const captured: SoatEvent[] = [];
    const handler = (event: SoatEvent) => {
      if (event.type === args.type) captured.push(event);
    };
    eventBus.on('soat:event', handler);
    try {
      const generationId = await args.action();
      const mine = () => {
        return captured.filter((event) => {
          return event.data.id === generationId;
        });
      };
      for (let tick = 0; tick < 200 && mine().length === 0; tick += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      return { generationId, events: mine() };
    } finally {
      eventBus.off('soat:event', handler);
    }
  };

  /** The record as the read route answers it. */
  const readGeneration = async (generationId: string) => {
    const res = await asAdmin().get(`/api/v1/generations/${generationId}`);
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  };

  /** An event's data as a webhook delivers it: serialized to JSON. */
  const wire = (event: SoatEvent): Record<string, unknown> => {
    return JSON.parse(JSON.stringify(event.data));
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();

    const setup = await setupProjectWithUsers({
      prefix: 'genevents',
      policyActions: ['agents:CreateAgent'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Generation Events Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    aiProviderId = provider.body.id;

    const tool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        type: 'client',
        name: 'lookup',
        parameters: { type: 'object', properties: {} },
      });
    expect(tool.status).toBe(201);
    clientToolId = tool.body.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('agents.generation.completed', () => {
    test('carries the generation record its GET returns', async () => {
      const agentId = await createAgent({ name: 'Completed Event Agent' });
      stub.reply(textCompletion('done'));

      const { generationId, events } = await captureEvents({
        type: 'agents.generation.completed',
        action: async () => {
          const res = await generate(agentId);
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('completed');
          return res.body.id;
        },
      });

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.resourceType).toBe('generation');
      expect(event.resourceId).toBe(generationId);
      expect(event.projectPublicId).toBe(projectId);
      expect(wire(event)).toEqual(await readGeneration(generationId));
      expect(event.data.status).toBe('completed');
      expect(event.data.output).toBeUndefined();
    });

    test('a turn resumed from tool outputs carries the record too', async () => {
      const agentId = await createAgent({
        name: 'Resumed Completed Event Agent',
        toolIds: [clientToolId],
      });
      stub.reply(
        toolCallCompletion([{ id: 'call_lookup', name: 'lookup' }]),
        textCompletion('resumed')
      );
      const paused = await generate(agentId);
      expect(paused.body.status).toBe('requires_action');

      const { generationId, events } = await captureEvents({
        type: 'agents.generation.completed',
        action: async () => {
          const res = await asAdmin()
            .post(
              `/api/v1/agents/${agentId}/generate/${paused.body.id}/tool-outputs`
            )
            .send({
              tool_outputs: [{ tool_call_id: 'call_lookup', output: 'ok' }],
            });
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('completed');
          return res.body.id;
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0].resourceType).toBe('generation');
      expect(events[0].resourceId).toBe(generationId);
      expect(wire(events[0])).toEqual(await readGeneration(generationId));
    });

    test('an unreadable record drops the event without failing the turn', async () => {
      const agentId = await createAgent({ name: 'Dropped Event Agent' });
      stub.reply(textCompletion('still answered'));
      const before = droppedEventCount({ stage: 'generation_lookup' });
      // Sanctioned force-failure: drives the `.catch` around the record read
      // the event carries; the turn itself runs for real.
      jest
        .spyOn(generationsModule, 'getGeneration')
        .mockRejectedValueOnce(new Error('db unavailable'));

      const res = await generate(agentId);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(droppedEventCount({ stage: 'generation_lookup' })).toBe(
        before + 1
      );
    });
  });

  describe('agents.generation.requires_action', () => {
    test('carries the record plus the pending required_action', async () => {
      const agentId = await createAgent({
        name: 'Requires Action Event Agent',
        toolIds: [clientToolId],
      });
      stub.reply(
        toolCallCompletion([
          { id: 'call_pending', name: 'lookup', args: { q: 'x' } },
        ])
      );

      const { generationId, events } = await captureEvents({
        type: 'agents.generation.requires_action',
        action: async () => {
          const res = await generate(agentId);
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('requires_action');
          return res.body.id;
        },
      });

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.resourceType).toBe('generation');
      expect(event.resourceId).toBe(generationId);
      const { required_action: requiredAction, ...record } = wire(event);
      expect(record).toEqual(await readGeneration(generationId));
      expect(requiredAction).toEqual({
        type: 'submit_tool_outputs',
        tool_calls: [
          { id: 'call_pending', tool_name: 'lookup', args: { q: 'x' } },
        ],
      });
    });
  });

  describe('agents.generation.failed', () => {
    test('carries the failed record its GET returns', async () => {
      const agentId = await createAgent({ name: 'Failed Event Agent' });
      stub.reply(providerFailure(400));

      const { generationId, events } = await captureEvents({
        type: 'agents.generation.failed',
        action: async () => {
          const res = await generate(agentId);
          expect(res.status).toBe(502);
          return res.body.error.meta.generation_id;
        },
      });

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.resourceType).toBe('generation');
      expect(event.resourceId).toBe(generationId);
      const record = await readGeneration(generationId);
      expect(wire(event)).toEqual(record);
      expect(record.status).toBe('failed');
      expect(record.error).toMatchObject({ code: 'AI_PROVIDER_ERROR' });
    });
  });

  describe('sessions.generation.completed', () => {
    test('names the generation and carries its record, session_id included', async () => {
      const agentId = await createAgent({ name: 'Session Completed Agent' });
      const sessionId = await createSession(agentId);
      stub.reply(textCompletion('session reply'));

      const { generationId, events } = await captureEvents({
        type: 'sessions.generation.completed',
        action: async () => {
          const res = await generateInSession(sessionId);
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('completed');
          return res.body.generation_id;
        },
      });

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.resourceType).toBe('generation');
      expect(event.resourceId).toBe(generationId);
      expect(wire(event)).toEqual(await readGeneration(generationId));
      expect(event.data.session_id).toBe(sessionId);
    });
  });

  describe('sessions.generation.requires_action', () => {
    test('carries the record plus the pending required_action', async () => {
      const agentId = await createAgent({
        name: 'Session Requires Action Agent',
        toolIds: [clientToolId],
      });
      const sessionId = await createSession(agentId);
      stub.reply(toolCallCompletion([{ id: 'call_session', name: 'lookup' }]));

      const { generationId, events } = await captureEvents({
        type: 'sessions.generation.requires_action',
        action: async () => {
          const res = await generateInSession(sessionId);
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('requires_action');
          return res.body.generation_id;
        },
      });

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.resourceType).toBe('generation');
      expect(event.resourceId).toBe(generationId);
      const { required_action: requiredAction, ...record } = wire(event);
      expect(record).toEqual(await readGeneration(generationId));
      expect(record.session_id).toBe(sessionId);
      expect(requiredAction).toEqual({
        type: 'submit_tool_outputs',
        tool_calls: [{ id: 'call_session', tool_name: 'lookup', args: {} }],
      });
    });
  });
});
