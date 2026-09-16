import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import type { SoatEvent } from 'src/lib/eventBus';
import { emitEvent } from 'src/lib/eventBus';
import * as extractionCompletionModule from 'src/lib/memoryExtractionCompletion';
import { dispatchMemoryRules } from 'src/lib/memoryRuleDispatch';

import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// Shared spies created once at module load (the `mockCreateGeneration`
// pattern): `afterEach` uses `clearAllMocks`, never `restoreAllMocks`.
const mockRunExtractionCompletion = jest.spyOn(
  extractionCompletionModule,
  'runExtractionCompletion'
);

/**
 * The dispatcher is driven directly rather than through a live bus listener.
 * That is the entry point for this behaviour: a rule fires from an event, and
 * awaiting the dispatch is what makes the assertions deterministic instead of
 * polling a fire-and-forget branch.
 */
describe('memory rule dispatch', () => {
  let adminToken: string;
  let scope: ProjectScope;
  let seq = 0;

  /**
   * A rule whose selector is `null` reads every agent in its project, so a test
   * that declares one needs a project of its own — otherwise it also fires on
   * every turn the tests after it seed, and each one starts failing for a
   * reason that is not its own.
   */
  type ProjectScope = {
    projectId: string;
    internalProjectId: number;
    aiProviderId: string;
  };

  const createProject = async (name: string): Promise<ProjectScope> => {
    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name });
    expect(projectRes.status).toBe(201);
    const projectId = projectRes.body.id;

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: `${name} provider`,
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(providerRes.status).toBe(201);

    return {
      projectId,
      internalProjectId: project!.id,
      aiProviderId: providerRes.body.id,
    };
  };

  const createStore = async (
    name: string,
    where: ProjectScope = scope
  ): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: where.projectId, name });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (
    name: string,
    where: ProjectScope = scope
  ): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: where.projectId,
        ai_provider_id: where.aiProviderId,
        name,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createRule = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-rules')
      .send({ on: 'agents.generation.completed', ...body });
    expect(res.status).toBe(201);
    return res.body;
  };

  /**
   * A completed turn, as the pipeline leaves it: a trace, a generation row
   * carrying the messages the turn answered, and nothing else.
   */
  const seedGeneration = async (args: {
    agentId: string;
    userMessage: string;
    source?: string;
    where?: ProjectScope;
  }): Promise<string> => {
    const where = args.where ?? scope;
    seq += 1;
    const publicId = `gen_rule_${seq}`;
    const agent = await db.Agent.findOne({ where: { publicId: args.agentId } });
    const trace = await db.Trace.create({
      publicId: `trace_rule_${seq}`,
      projectId: where.internalProjectId,
      agentId: agent!.id,
    });
    await db.Generation.create({
      publicId,
      projectId: where.internalProjectId,
      agentId: agent!.id,
      traceId: trace.id,
      status: 'completed',
      startedAt: new Date(),
      source: args.source ?? null,
      inputMessages: [{ role: 'user', content: args.userMessage }],
    });
    return publicId;
  };

  const completedEvent = (args: {
    generationId: string;
    assistantContent: string;
    where?: ProjectScope;
  }): SoatEvent => {
    const where = args.where ?? scope;
    return {
      type: 'agents.generation.completed',
      projectId: where.internalProjectId,
      projectPublicId: where.projectId,
      resourceType: 'generation',
      resourceId: args.generationId,
      data: {
        id: args.generationId,
        status: 'completed',
        output: { model: 'test-model', content: args.assistantContent },
      },
      timestamp: new Date().toISOString(),
    };
  };

  const listMemories = async (memoryStoreId: string) => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/memories?memory_store_id=${memoryStoreId}`
    );
    expect(res.status).toBe(200);
    return res.body.data as Array<{
      id: string;
      content: string;
      source_type: string;
      tags: Record<string, string> | null;
    }>;
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'ruledispatchadmin', password: 'supersecret' });
    adminToken = await loginAs('ruledispatchadmin', 'supersecret');

    scope = await createProject('Rule Dispatch Project');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('the built-in extractor', () => {
    test('writes the facts it proposes into the rule’s store', async () => {
      const storeId = await createStore('BuiltIn Store');
      const agentId = await createAgent('BuiltInAgent');
      await createRule({
        memory_store_id: storeId,
        source_agent_ids: [agentId],
      });
      const generationId = await seedGeneration({
        agentId,
        userMessage: 'I prefer to be contacted by email.',
      });

      mockRunExtractionCompletion.mockResolvedValueOnce(
        '["User prefers to be contacted by email"]'
      );

      await dispatchMemoryRules(
        completedEvent({
          generationId,
          assistantContent: 'Noted, I will use email.',
        })
      );

      const memories = await listMemories(storeId);
      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('User prefers to be contacted by email');

      // The transcript the rule reads is both sides of the finished turn.
      const call = mockRunExtractionCompletion.mock.calls[0][0];
      expect(call.agentId).toBe(agentId);
      expect(call.prompt).toContain('I prefer to be contacted by email.');
      expect(call.prompt).toContain('Noted, I will use email.');
    });

    test('names the rule on the assertion it writes', async () => {
      const storeId = await createStore('Assertion Store');
      const agentId = await createAgent('AssertionAgent');
      const rule = await createRule({
        memory_store_id: storeId,
        source_agent_ids: [agentId],
      });
      const generationId = await seedGeneration({
        agentId,
        userMessage: 'My shipping address is 5 Elm Street.',
      });

      mockRunExtractionCompletion.mockResolvedValueOnce(
        '["User shipping address is 5 Elm Street"]'
      );

      await dispatchMemoryRules(
        completedEvent({ generationId, assistantContent: 'Noted.' })
      );

      const memories = await listMemories(storeId);
      const assertions = await authenticatedTestClient(adminToken).get(
        `/api/v1/memories/${memories[0].id}/assertions`
      );

      expect(assertions.status).toBe(200);
      expect(assertions.body.data).toHaveLength(1);
      expect(assertions.body.data[0]).toMatchObject({
        mechanism: 'rule',
        rule_id: rule.id,
        generation_id: generationId,
        // The source agent is the asserter; the rule decides what is accepted.
        principal_type: 'agent',
        principal_id: agentId,
        outcome: 'created',
      });
    });

    test('records the per-rule counts on the generation', async () => {
      const storeId = await createStore('Summary Store');
      const agentId = await createAgent('SummaryAgent');
      const rule = await createRule({
        memory_store_id: storeId,
        source_agent_ids: [agentId],
      });
      const generationId = await seedGeneration({
        agentId,
        userMessage: 'My timezone is CET.',
      });

      // Two identical candidates: one lands, one is skipped as a duplicate.
      mockRunExtractionCompletion.mockResolvedValueOnce(
        '["User timezone is CET", "User timezone is CET"]'
      );

      await dispatchMemoryRules(
        completedEvent({ generationId, assistantContent: 'Got it.' })
      );

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/generations/${generationId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.extraction).toEqual({
        [rule.id]: {
          candidates: 2,
          created: 1,
          superseded: 0,
          skipped: 1,
        },
      });
    });

    test('a malformed completion writes nothing and does not throw', async () => {
      const storeId = await createStore('Malformed Store');
      const agentId = await createAgent('MalformedAgent');
      await createRule({
        memory_store_id: storeId,
        source_agent_ids: [agentId],
      });
      const generationId = await seedGeneration({
        agentId,
        userMessage: 'Anything at all.',
      });

      mockRunExtractionCompletion.mockResolvedValueOnce('not json at all');

      await expect(
        dispatchMemoryRules(
          completedEvent({ generationId, assistantContent: 'Sure.' })
        )
      ).resolves.toBeUndefined();

      expect(await listMemories(storeId)).toHaveLength(0);
    });
  });

  describe('selectors', () => {
    test('a rule ignores a turn by an agent its selector does not name', async () => {
      const storeId = await createStore('Selector Store');
      const namedAgentId = await createAgent('SelectorNamedAgent');
      const otherAgentId = await createAgent('SelectorOtherAgent');
      await createRule({
        memory_store_id: storeId,
        source_agent_ids: [namedAgentId],
      });
      const generationId = await seedGeneration({
        agentId: otherAgentId,
        userMessage: 'A fact from an agent the rule does not read.',
      });

      await dispatchMemoryRules(
        completedEvent({ generationId, assistantContent: 'Noted.' })
      );

      expect(mockRunExtractionCompletion).not.toHaveBeenCalled();
      expect(await listMemories(storeId)).toHaveLength(0);
    });

    test('a null selector reads every agent in the project', async () => {
      const where = await createProject('Unscoped Selector Project');
      const storeId = await createStore('Unscoped Selector Store', where);
      const agentId = await createAgent('UnscopedSelectorAgent', where);
      await createRule({ memory_store_id: storeId, source_agent_ids: null });
      const generationId = await seedGeneration({
        agentId,
        userMessage: 'The office is in Lisbon.',
        where,
      });

      mockRunExtractionCompletion.mockResolvedValueOnce(
        '["The office is in Lisbon"]'
      );

      await dispatchMemoryRules(
        completedEvent({ generationId, assistantContent: 'Noted.', where })
      );

      expect(await listMemories(storeId)).toHaveLength(1);
    });

    test('a disabled rule never fires', async () => {
      const storeId = await createStore('Disabled Store');
      const agentId = await createAgent('DisabledRuleAgent');
      await createRule({
        memory_store_id: storeId,
        source_agent_ids: [agentId],
        enabled: false,
      });
      const generationId = await seedGeneration({
        agentId,
        userMessage: 'A fact nobody collects.',
      });

      await dispatchMemoryRules(
        completedEvent({ generationId, assistantContent: 'Noted.' })
      );

      expect(mockRunExtractionCompletion).not.toHaveBeenCalled();
      expect(await listMemories(storeId)).toHaveLength(0);
    });

    test('two rules on one store both fire, and the summary separates them', async () => {
      const storeId = await createStore('Two Rules Store');
      const agentId = await createAgent('TwoRulesAgent');
      const general = await createRule({
        memory_store_id: storeId,
        source_agent_ids: [agentId],
      });
      const strict = await createRule({
        memory_store_id: storeId,
        source_agent_ids: [agentId],
        prompt: 'Only billing facts',
      });
      const generationId = await seedGeneration({
        agentId,
        userMessage: 'The invoice is paid and my cat is called Mia.',
      });

      mockRunExtractionCompletion
        .mockResolvedValueOnce('["The cat is called Mia"]')
        .mockResolvedValueOnce('["The invoice is paid"]');

      await dispatchMemoryRules(
        completedEvent({ generationId, assistantContent: 'Noted.' })
      );

      // Each rule ran its own handler, with its own instructions.
      expect(mockRunExtractionCompletion).toHaveBeenCalledTimes(2);
      const prompts = mockRunExtractionCompletion.mock.calls.map((call) => {
        return call[0].prompt;
      });
      expect(
        prompts.some((prompt) => {
          return prompt.includes('Only billing facts');
        })
      ).toBe(true);

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/generations/${generationId}`
      );
      // One summary per rule: a flat pair of counts could not say which rule
      // produced them.
      expect(Object.keys(res.body.extraction).sort()).toEqual(
        [general.id, strict.id].sort()
      );
      const totals = Object.values(
        res.body.extraction as Record<string, { candidates: number }>
      ).map((summary) => {
        return summary.candidates;
      });
      expect(totals).toEqual([1, 1]);

      // The unit suite's embedding stub returns one constant vector, so the
      // two distinct facts land as a create and a duplicate skip rather than
      // as two memories. What this test pins is the dispatch, not the ranking.
      expect(await listMemories(storeId)).toHaveLength(1);
    });
  });

  describe('the conversation message event', () => {
    test('reads the persisted reply and feeds a handler', async () => {
      const where = await createProject('Message Event Project');
      const storeId = await createStore('Message Event Store', where);
      const sourceAgentId = await createAgent('MessageEventAgent', where);
      const handlerAgentId = await createAgent('MessageEventHandler', where);
      await createRule({
        memory_store_id: storeId,
        on: 'conversations.message.generated',
        source_agent_ids: [sourceAgentId],
        agent_id: handlerAgentId,
      });

      const convRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/conversations')
        .send({ project_id: where.projectId });
      expect(convRes.status).toBe(201);
      const messageRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${convRes.body.id}/messages`)
        .send({ role: 'assistant', message: 'Your renewal is confirmed.' });
      expect(messageRes.status).toBe(201);

      const generationId = await seedGeneration({
        agentId: sourceAgentId,
        userMessage: 'Did my renewal go through?',
        where,
      });

      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_message_handler',
        traceId: 'trace_message_handler',
        status: 'completed',
        output: {
          model: 'test-model',
          content: '{"facts":[{"content":"The renewal is confirmed"}]}',
          finishReason: 'stop',
        },
      });

      await dispatchMemoryRules({
        type: 'conversations.message.generated',
        projectId: where.internalProjectId,
        projectPublicId: where.projectId,
        resourceType: 'conversation_message',
        resourceId: messageRes.body.document_id,
        data: {
          conversationId: convRes.body.id,
          agentId: sourceAgentId,
          generationId,
        },
        timestamp: new Date().toISOString(),
      });

      const memories = await listMemories(storeId);
      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('The renewal is confirmed');

      // The transcript carries the persisted reply, which lives in the
      // message's document rather than on the generation.
      const handlerCall = mockCreateGeneration.mock.calls[0][0];
      expect(String(handlerCall.messages[0].content)).toContain(
        'Your renewal is confirmed.'
      );
    });
  });

  describe('the loop guard', () => {
    test('a generation this module started is never read back', async () => {
      const where = await createProject('Loop Source Project');
      const storeId = await createStore('Loop Source Store', where);
      const agentId = await createAgent('LoopSourceAgent', where);
      await createRule({ memory_store_id: storeId, source_agent_ids: null });
      const generationId = await seedGeneration({
        agentId,
        userMessage: 'A handler’s own turn.',
        source: 'memory_rule',
        where,
      });

      await dispatchMemoryRules(
        completedEvent({ generationId, assistantContent: 'Facts.', where })
      );

      expect(mockRunExtractionCompletion).not.toHaveBeenCalled();
      expect(await listMemories(storeId)).toHaveLength(0);
    });

    test('a handler agent’s turn is skipped however it was started', async () => {
      const where = await createProject('Loop Handler Project');
      const storeId = await createStore('Loop Handler Store', where);
      const handlerAgentId = await createAgent('LoopHandlerAgent', where);
      await createRule({
        memory_store_id: storeId,
        agent_id: handlerAgentId,
        source_agent_ids: null,
      });
      // Started by hand, not by the dispatcher, so it carries no marker.
      const generationId = await seedGeneration({
        agentId: handlerAgentId,
        userMessage: 'Testing the handler directly.',
        where,
      });

      await dispatchMemoryRules(
        completedEvent({
          generationId,
          assistantContent: '{"facts":[]}',
          where,
        })
      );

      expect(mockCreateGeneration).not.toHaveBeenCalled();
      expect(await listMemories(storeId)).toHaveLength(0);
    });
  });

  describe('the bus subscription', () => {
    test('an emitted event reaches the dispatcher', async () => {
      const where = await createProject('Bus Subscription Project');
      const storeId = await createStore('Bus Subscription Store', where);
      const agentId = await createAgent('BusSubscriptionAgent', where);
      await createRule({ memory_store_id: storeId, source_agent_ids: null });
      const generationId = await seedGeneration({
        agentId,
        userMessage: 'The standup is at 09:30.',
        where,
      });

      mockRunExtractionCompletion.mockResolvedValueOnce(
        '["The standup is at 09:30"]'
      );

      // `app.ts` subscribed the listener at import time, and the handler is
      // fire-and-forget by design, so the write is the only observable signal.
      // Bounded polling rather than a fixed sleep: it exits on the first read
      // that sees the row.
      emitEvent(
        completedEvent({ generationId, assistantContent: 'Noted.', where })
      );

      const deadline = Date.now() + 10_000;
      let memories = await listMemories(storeId);
      while (memories.length === 0 && Date.now() < deadline) {
        memories = await listMemories(storeId);
      }

      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('The standup is at 09:30');
    });
  });

  describe('handlers', () => {
    test('an agent handler’s facts are written, tags and all', async () => {
      const storeId = await createStore('Agent Handler Store');
      const sourceAgentId = await createAgent('HandlerSourceAgent');
      const handlerAgentId = await createAgent('HandlerAgent');
      await createRule({
        memory_store_id: storeId,
        source_agent_ids: [sourceAgentId],
        agent_id: handlerAgentId,
      });
      const generationId = await seedGeneration({
        agentId: sourceAgentId,
        userMessage: 'The invoice is overdue.',
      });

      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_handler_reply',
        traceId: 'trace_handler_reply',
        status: 'completed',
        output: {
          model: 'test-model',
          content:
            '{"facts":[{"content":"The invoice is overdue","tags":{"kind":"billing"}}]}',
          finishReason: 'stop',
        },
      });

      await dispatchMemoryRules(
        completedEvent({ generationId, assistantContent: 'I will chase it.' })
      );

      const memories = await listMemories(storeId);
      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('The invoice is overdue');
      expect(memories[0].tags).toEqual({ kind: 'billing' });

      // The handler's own turn is stamped, which is half the loop guard.
      const handlerCall = mockCreateGeneration.mock.calls[0][0];
      expect(handlerCall.agentId).toBe(handlerAgentId);
      expect(handlerCall.source).toBe('memory_rule');
      // The built-in extractor is not involved when a handler is named.
      expect(mockRunExtractionCompletion).not.toHaveBeenCalled();
    });

    test('a failing agent handler writes nothing and does not throw', async () => {
      const storeId = await createStore('Failing Handler Store');
      const sourceAgentId = await createAgent('FailingHandlerSourceAgent');
      const handlerAgentId = await createAgent('FailingHandlerAgent');
      await createRule({
        memory_store_id: storeId,
        source_agent_ids: [sourceAgentId],
        agent_id: handlerAgentId,
      });
      const generationId = await seedGeneration({
        agentId: sourceAgentId,
        userMessage: 'Anything.',
      });

      mockCreateGeneration.mockRejectedValueOnce(
        new Error('provider unavailable')
      );

      await expect(
        dispatchMemoryRules(
          completedEvent({ generationId, assistantContent: 'Sure.' })
        )
      ).resolves.toBeUndefined();

      expect(await listMemories(storeId)).toHaveLength(0);
    });

    describe('a tool handler', () => {
      let handlerServer: http.Server;
      let handlerServerUrl: string;
      let lastToolInput: Record<string, unknown> | undefined;

      beforeAll(async () => {
        handlerServer = http.createServer((req, res) => {
          let body = '';
          req.on('data', (chunk) => {
            body += String(chunk);
          });
          req.on('end', () => {
            lastToolInput = body ? JSON.parse(body) : undefined;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                facts: [{ content: 'The customer is on the annual plan' }],
              })
            );
          });
        });
        await new Promise<void>((resolve) => {
          handlerServer.listen(0, '127.0.0.1', resolve);
        });
        const { port } = handlerServer.address() as AddressInfo;
        handlerServerUrl = `http://127.0.0.1:${port}`;
      });

      afterAll(async () => {
        await new Promise<void>((resolve) => {
          handlerServer.close(() => {
            resolve();
          });
        });
      });

      test('is handed the turn and its facts are written', async () => {
        const storeId = await createStore('Tool Handler Store');
        const sourceAgentId = await createAgent('ToolHandlerSourceAgent');

        const toolRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/tools')
          .send({
            project_id: scope.projectId,
            name: 'memory-rule-handler',
            type: 'http',
            execute: { url: `${handlerServerUrl}/facts`, method: 'POST' },
          });
        expect(toolRes.status).toBe(201);

        const rule = await createRule({
          memory_store_id: storeId,
          source_agent_ids: [sourceAgentId],
          tool_id: toolRes.body.id,
          preset_parameters: { style: 'terse' },
        });
        const generationId = await seedGeneration({
          agentId: sourceAgentId,
          userMessage: 'I moved to the annual plan.',
        });

        await dispatchMemoryRules(
          completedEvent({ generationId, assistantContent: 'Confirmed.' })
        );

        const memories = await listMemories(storeId);
        expect(memories).toHaveLength(1);
        expect(memories[0].content).toBe('The customer is on the annual plan');

        expect(lastToolInput).toMatchObject({
          style: 'terse',
          event: 'agents.generation.completed',
          rule_id: rule.id,
          agent_id: sourceAgentId,
          generation_id: generationId,
        });
        expect(String(lastToolInput!.transcript)).toContain(
          'I moved to the annual plan.'
        );
      });
    });
  });
});
