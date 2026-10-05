import {
  type ChatReply,
  type ChatRequest,
  startChatCompletionStub,
} from '../../fixtures/chatCompletionStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The built-in extractor: a memory rule with no handler, fired by a finished
 * turn through the event flow, runs one tool-less completion over the turn's
 * transcript and writes the facts it proposes.
 *
 * Both the turn and the extraction call go to a local chat-completions stub,
 * told apart by the response contract the extraction prompt always carries.
 * A firing is complete once the turn's generation record carries the rule's
 * summary, which is what every test waits for.
 */
const EXTRACTION_CONTRACT = 'Respond with a JSON array';

let extractionReply: ChatReply = { content: '["The customer prefers email."]' };

const isExtraction = (request: ChatRequest): boolean => {
  return request.messages.some((message) => {
    return (
      typeof message.content === 'string' &&
      message.content.includes(EXTRACTION_CONTRACT)
    );
  });
};

const stubPromise = startChatCompletionStub({
  reply: (request) => {
    if (isExtraction(request)) return extractionReply;
    const said = request.messages
      .filter((message) => {
        return message.role === 'user';
      })
      .map((message) => {
        return String(message.content);
      })
      .join('')
      .trim();
    // A turn that said nothing is answered with nothing, so its transcript is
    // empty.
    return { content: said ? 'Noted.' : '' };
  },
});

type Summary = {
  candidates: number;
  created: number;
  superseded: number;
  skipped: number;
};

describe('Memory rules — the built-in extractor', () => {
  let adminToken: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin().post(path).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** A project of its own per test, so no other test's rule fires on its turns. */
  const createScope = async (args: { defaultModel?: string } = {}) => {
    const { baseUrl } = await stubPromise;
    const projectId = await create('/api/v1/projects', {
      name: `Extraction ${Math.random().toString(36).slice(2)}`,
    });
    const providerId = await create('/api/v1/ai-providers', {
      project_id: projectId,
      name: 'Extraction provider',
      provider: 'ollama',
      default_model: args.defaultModel ?? 'default-stub-model',
      base_url: baseUrl,
    });
    const memoryStoreId = await create('/api/v1/memory-stores', {
      project_id: projectId,
      name: 'Extracted facts',
    });
    return { projectId, providerId, memoryStoreId, baseUrl };
  };

  const createRule = async (body: Record<string, unknown>) => {
    return create('/api/v1/memory-rules', {
      on: 'agents.generation.completed',
      ...body,
    });
  };

  /**
   * Runs one turn and waits for the rule it fires to record its summary.
   * Returns the summary, the turn's id and the extraction requests it caused.
   */
  const runTurn = async (args: { agentId: string; content?: string }) => {
    const stub = await stubPromise;
    const before = stub.requests.length;
    const res = await asAdmin()
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({
        messages: [
          {
            role: 'user',
            content: args.content ?? 'Please email me rather than calling.',
          },
        ],
      });
    expect(res.status).toBe(200);
    const generationId = res.body.id as string;

    let summaries: Record<string, Summary> | undefined;
    for (let attempt = 0; attempt < 200 && !summaries; attempt += 1) {
      const generation = await asAdmin().get(
        `/api/v1/generations/${generationId}`
      );
      summaries = generation.body.extraction ?? undefined;
      if (!summaries) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
    }
    expect(summaries).toBeDefined();

    return {
      generationId,
      summaries: summaries!,
      extractions: stub.requests.slice(before).filter(isExtraction),
    };
  };

  const memoriesIn = async (memoryStoreId: string) => {
    const res = await asAdmin().get(
      `/api/v1/memories?memory_store_id=${memoryStoreId}`
    );
    return res.body.data as Array<{ id: string; content: string }>;
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'extractionadmin', password: 'supersecret' });
    adminToken = await loginAs('extractionadmin', 'supersecret');
  });

  afterAll(async () => {
    await (await stubPromise).close();
  });

  afterEach(() => {
    extractionReply = { content: '["The customer prefers email."]' };
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test("extracts with the source agent's provider at its default model", async () => {
      const scope = await createScope();
      const agentId = await create('/api/v1/agents', {
        project_id: scope.projectId,
        ai_provider_id: scope.providerId,
        name: 'source-agent',
      });
      const ruleId = await createRule({ memory_store_id: scope.memoryStoreId });

      const { generationId, summaries, extractions } = await runTurn({
        agentId,
      });

      expect(summaries[ruleId]).toEqual({
        candidates: 1,
        created: 1,
        superseded: 0,
        skipped: 0,
      });
      expect(extractions).toHaveLength(1);
      expect(extractions[0].model).toBe('default-stub-model');
      // The default instructions, the response contract and the transcript.
      const prompt = String(extractions[0].messages[0].content);
      expect(prompt).toContain('Extract discrete, atomic facts');
      expect(prompt).toContain(
        'user: Please email me rather than calling.\nassistant: Noted.'
      );

      const [written] = await memoriesIn(scope.memoryStoreId);
      expect(written.content).toBe('The customer prefers email.');
      const assertions = await asAdmin().get(
        `/api/v1/memories/${written.id}/assertions`
      );
      expect(assertions.body.data[0]).toMatchObject({
        mechanism: 'rule',
        generation_id: generationId,
        principal_type: 'agent',
        principal_id: agentId,
      });
    });

    test("uses the agent's own model when it names one", async () => {
      const scope = await createScope();
      const agentId = await create('/api/v1/agents', {
        project_id: scope.projectId,
        ai_provider_id: scope.providerId,
        name: 'model-agent',
        model: 'agent-stub-model',
      });
      await createRule({ memory_store_id: scope.memoryStoreId });

      const { extractions } = await runTurn({ agentId });

      expect(extractions[0].model).toBe('agent-stub-model');
    });

    // A custom prompt replaces the task instructions only: the parser accepts
    // nothing but a JSON array, so the contract and the transcript always
    // follow it.
    test("a rule's prompt replaces the instructions, never the contract", async () => {
      const scope = await createScope();
      const agentId = await create('/api/v1/agents', {
        project_id: scope.projectId,
        ai_provider_id: scope.providerId,
        name: 'prompt-agent',
      });
      await createRule({
        memory_store_id: scope.memoryStoreId,
        prompt: 'Only billing facts.',
      });

      const { extractions } = await runTurn({ agentId });

      const prompt = String(extractions[0].messages[0].content);
      expect(prompt.startsWith('Only billing facts.\n')).toBe(true);
      expect(prompt).not.toContain('Extract discrete, atomic facts');
      expect(prompt).toContain(EXTRACTION_CONTRACT);
      expect(prompt).toContain('assistant: Noted.');
    });

    test("a rule's provider takes the call, at that provider's default model", async () => {
      const scope = await createScope();
      const cheapProviderId = await create('/api/v1/ai-providers', {
        project_id: scope.projectId,
        name: 'Cheap provider',
        provider: 'ollama',
        default_model: 'cheap-default-model',
        base_url: scope.baseUrl,
      });
      // The agent's own model is meaningless on another provider.
      const agentId = await create('/api/v1/agents', {
        project_id: scope.projectId,
        ai_provider_id: scope.providerId,
        name: 'override-agent',
        model: 'agent-stub-model',
      });
      await createRule({
        memory_store_id: scope.memoryStoreId,
        ai_provider_id: cheapProviderId,
      });

      const { extractions } = await runTurn({ agentId });

      expect(extractions[0].model).toBe('cheap-default-model');
    });

    test("a rule's model wins over its provider's default", async () => {
      const scope = await createScope();
      const cheapProviderId = await create('/api/v1/ai-providers', {
        project_id: scope.projectId,
        name: 'Cheap provider',
        provider: 'ollama',
        default_model: 'cheap-default-model',
        base_url: scope.baseUrl,
      });
      const agentId = await create('/api/v1/agents', {
        project_id: scope.projectId,
        ai_provider_id: scope.providerId,
        name: 'model-override-agent',
      });
      await createRule({
        memory_store_id: scope.memoryStoreId,
        ai_provider_id: cheapProviderId,
        model: 'tiny-model',
      });

      const { extractions } = await runTurn({ agentId });

      expect(extractions[0].model).toBe('tiny-model');
    });

    test('an agent binding no provider extracts through the project default route', async () => {
      const scope = await createScope();
      const routeId = await create('/api/v1/model-routes', {
        project_id: scope.projectId,
        name: 'extraction-default-route',
        targets: [{ ai_provider_id: scope.providerId, model: 'routed-model' }],
      });
      const patched = await asAdmin()
        .patch(`/api/v1/projects/${scope.projectId}`)
        .send({ default_model_route_id: routeId });
      expect(patched.status).toBe(200);
      const agentId = await create('/api/v1/agents', {
        project_id: scope.projectId,
        name: 'unbound-agent',
      });
      await createRule({ memory_store_id: scope.memoryStoreId });

      const { extractions } = await runTurn({ agentId });

      // The target's own model, not the route id.
      expect(extractions[0].model).toBe('routed-model');
    });

    test('meters the extraction as llm_tokens attributed to the agent, not the turn', async () => {
      const scope = await createScope();
      const agentId = await create('/api/v1/agents', {
        project_id: scope.projectId,
        ai_provider_id: scope.providerId,
        name: 'metered-agent',
      });
      await createRule({ memory_store_id: scope.memoryStoreId });

      await runTurn({ agentId });

      // The metering write does not hold up the firing, so poll the meter.
      let events: Array<Record<string, unknown>> = [];
      for (
        let attempt = 0;
        attempt < 200 && events.length === 0;
        attempt += 1
      ) {
        const res = await asAdmin().get(
          `/api/v1/usage/events?agent_id=${agentId}&source=memory_extraction`
        );
        events = res.body.data;
        if (events.length === 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
        }
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        meter_type: 'llm_tokens',
        provider: 'ollama',
        model: 'default-stub-model',
        ai_provider_id: scope.providerId,
        // Extraction runs no generation of its own.
        generation_id: null,
      });
    });

    test('a failed completion proposes nothing rather than failing the firing', async () => {
      const scope = await createScope();
      const agentId = await create('/api/v1/agents', {
        project_id: scope.projectId,
        ai_provider_id: scope.providerId,
        name: 'failing-agent',
      });
      const ruleId = await createRule({ memory_store_id: scope.memoryStoreId });
      extractionReply = { error: 'model overloaded' };

      const { summaries, extractions } = await runTurn({ agentId });

      expect(extractions).toHaveLength(1);
      expect(summaries[ruleId].candidates).toBe(0);
      expect(await memoriesIn(scope.memoryStoreId)).toHaveLength(0);
    });

    test('a turn with nothing said proposes nothing, without calling the model', async () => {
      const scope = await createScope();
      const agentId = await create('/api/v1/agents', {
        project_id: scope.projectId,
        ai_provider_id: scope.providerId,
        name: 'silent-agent',
      });
      const ruleId = await createRule({ memory_store_id: scope.memoryStoreId });

      const { summaries, extractions } = await runTurn({
        agentId,
        content: '   ',
      });

      expect(extractions).toHaveLength(0);
      expect(summaries[ruleId].candidates).toBe(0);
    });
  });
});
