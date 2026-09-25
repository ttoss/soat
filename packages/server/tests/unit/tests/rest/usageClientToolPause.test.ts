import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { recordGenerationUsage } from 'src/lib/usage';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

type WireEvent = {
  generation_id: string | null;
  meter_type: string;
  components: Array<{ component: string; quantity: number }>;
};

// Each provider call reports `BASE_PROMPT_TOKENS + 10 × <tool results it saw>`
// prompt tokens, so every call's event is identifiable by its input count.
const BASE_PROMPT_TOKENS = 100;

type StubRequest = {
  messages?: Array<{ role: string }>;
  tools?: Array<{ function: { name: string } }>;
};

/**
 * A turn that pauses on a `client` tool spends a provider call per segment, and
 * every segment is metered when it returns: the paused one before
 * `requires_action` is answered, a resumed one for the calls it made alone.
 */
describe('Usage of a generation that pauses on a client tool', () => {
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;
  let clientToolId: string;
  let stubServer: Server;
  // Tool results a request must carry before the stub answers with text.
  let pausesBeforeAnswer = 2;

  const toolResultsIn = (body: StubRequest) => {
    return (body.messages ?? []).filter((message) => {
      return message.role === 'tool';
    }).length;
  };

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body: StubRequest = JSON.parse(raw);
        const seen = toolResultsIn(body);
        const callsTool = seen < pausesBeforeAnswer;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl-pause-${seen}`,
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: callsTool
                  ? {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: `call_${seen}`,
                          type: 'function',
                          function: {
                            name: body.tools?.[0]?.function.name,
                            arguments: JSON.stringify({ value: `${seen}` }),
                          },
                        },
                      ],
                    }
                  : { role: 'assistant', content: 'final answer' },
                finish_reason: callsTool ? 'tool_calls' : 'stop',
              },
            ],
            usage: {
              prompt_tokens: BASE_PROMPT_TOKENS + 10 * seen,
              completion_tokens: 5,
              total_tokens: BASE_PROMPT_TOKENS + 10 * seen + 5,
            },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const createClientTool = async (args: {
    name: string;
    extra?: Record<string, unknown>;
  }) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: args.name,
        type: 'client',
        description: 'Probe the caller',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
        ...args.extra,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createAgent = async (
    args: { toolId?: string; extra?: Record<string, unknown> } = {}
  ) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProviderId,
        project_id: projectId,
        name: `Pause Agent ${Math.random()}`,
        tool_bindings: [{ tool_id: args.toolId ?? clientToolId }],
        ...args.extra,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const generate = async (agentId: string) => {
    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'probe' }] });
    expect(res.status).toBe(200);
    return res.body;
  };

  const submitOutput = async (args: {
    agentId: string;
    generation: {
      id: string;
      required_action: { tool_calls: [{ id: string }] };
    };
  }) => {
    return authenticatedTestClient(userToken)
      .post(
        `/api/v1/agents/${args.agentId}/generate/${args.generation.id}/tool-outputs`
      )
      .send({
        tool_outputs: [
          {
            tool_call_id: args.generation.required_action.tool_calls[0].id,
            output: 'probed',
          },
        ],
      });
  };

  const eventsOf = async (generationId: string): Promise<WireEvent[]> => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/usage/events?generation_id=${generationId}&limit=100`
    );
    expect(res.status).toBe(200);
    return res.body.data;
  };

  /** Each event's `input_tokens`, ascending — one entry per metered call. */
  const inputTokensOf = (events: WireEvent[]): number[] => {
    return events
      .map((event) => {
        const input = event.components.find((component) => {
          return component.component === 'input_tokens';
        });
        return Number(input?.quantity);
      })
      .sort((a, b) => {
        return a - b;
      });
  };

  beforeAll(async () => {
    const stubBaseUrl = await startStubServer();
    const setup = await setupProjectWithUsers({
      prefix: 'usagepause',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateAgentGeneration',
        'tools:CreateTool',
        'guardrails:CreateGuardrail',
        'generations:GetGeneration',
        'usage:ListEvents',
        'usage:GetAggregate',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Pause Stub Provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });
    expect(providerRes.status).toBe(201);
    aiProviderId = providerRes.body.id;

    clientToolId = await createClientTool({ name: 'client_probe' });
  }, 60000);

  beforeEach(() => {
    pausesBeforeAnswer = 2;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  test('the paused call is metered before requires_action is answered', async () => {
    const agentId = await createAgent();
    const paused = await generate(agentId);
    expect(paused.status).toBe('requires_action');

    const events = await eventsOf(paused.id);
    expect(events).toHaveLength(1);
    expect(events[0].meter_type).toBe('llm_tokens');
    expect(events[0].generation_id).toBe(paused.id);
    expect(inputTokensOf(events)).toEqual([BASE_PROMPT_TOKENS]);
  });

  test('a generation that pauses twice and completes has one event per call', async () => {
    const agentId = await createAgent();
    const first = await generate(agentId);
    expect(first.status).toBe('requires_action');

    const second = await submitOutput({ agentId, generation: first });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('requires_action');
    expect(inputTokensOf(await eventsOf(first.id))).toEqual([
      BASE_PROMPT_TOKENS,
      BASE_PROMPT_TOKENS + 10,
    ]);

    const completed = await submitOutput({ agentId, generation: second.body });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('completed');

    const events = await eventsOf(first.id);
    expect(inputTokensOf(events)).toEqual([
      BASE_PROMPT_TOKENS,
      BASE_PROMPT_TOKENS + 10,
      BASE_PROMPT_TOKENS + 20,
    ]);
    for (const event of events) {
      expect(event.generation_id).toBe(first.id);
    }
  });

  test('re-metering a segment already recorded writes nothing', async () => {
    pausesBeforeAnswer = 1;
    const agentId = await createAgent();
    const paused = await generate(agentId);
    const completed = await submitOutput({ agentId, generation: paused });
    expect(completed.body.status).toBe('completed');
    expect(await eventsOf(paused.id)).toHaveLength(2);

    // Replays of both segments: the one that paused and the resumed one that
    // started after its single step.
    await recordGenerationUsage({
      generationId: paused.id,
      model: 'stub-model',
      usage: undefined,
      stepsAlreadySpent: 0,
    });
    await recordGenerationUsage({
      generationId: paused.id,
      model: 'stub-model',
      usage: undefined,
      stepsAlreadySpent: 1,
    });

    expect(await eventsOf(paused.id)).toHaveLength(2);
  });

  test('a generation abandoned at requires_action keeps its paused calls', async () => {
    const agentId = await createAgent();
    const first = await generate(agentId);
    const second = await submitOutput({ agentId, generation: first });
    expect(second.body.status).toBe('requires_action');

    const generation = await authenticatedTestClient(userToken).get(
      `/api/v1/generations/${first.id}`
    );
    expect(generation.status).toBe(200);
    expect(generation.body.status).toBe('requires_action');
    expect(inputTokensOf(await eventsOf(first.id))).toEqual([
      BASE_PROMPT_TOKENS,
      BASE_PROMPT_TOKENS + 10,
    ]);
  });

  test('a generation whose every call paused counts as a distinct generation', async () => {
    const agentId = await createAgent();
    const paused = await generate(agentId);
    expect(paused.status).toBe('requires_action');

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/usage/aggregate?project_id=${projectId}&agent_id=${agentId}` +
        '&group_by=orchestration_run&include=distinct'
    );
    expect(res.status).toBe(200);
    expect(res.body.totals.distinct.generations).toBe(1);
  });

  test('a resumed call that fails output_schema is metered beside the paused one', async () => {
    pausesBeforeAnswer = 1;
    const agentId = await createAgent({
      extra: {
        output_schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      },
    });
    const paused = await generate(agentId);
    expect(paused.status).toBe('requires_action');

    const failed = await submitOutput({ agentId, generation: paused });
    expect(failed.status).toBe(502);

    expect(inputTokensOf(await eventsOf(paused.id))).toEqual([
      BASE_PROMPT_TOKENS,
      BASE_PROMPT_TOKENS + 10,
    ]);
  });

  test('a call whose client calls were all blocked is metered before the server resumes it', async () => {
    pausesBeforeAnswer = 1;
    const guardrail = await authenticatedTestClient(userToken)
      .post('/api/v1/guardrails')
      .send({
        project_id: projectId,
        name: 'Block the probe',
        document: { class: 'D' },
      });
    expect(guardrail.status).toBe(201);
    const blockedToolId = await createClientTool({
      name: 'blocked_probe',
      extra: { guardrail_ids: [guardrail.body.id] },
    });

    const agentId = await createAgent({ toolId: blockedToolId });
    const completed = await generate(agentId);
    expect(completed.status).toBe('completed');

    expect(inputTokensOf(await eventsOf(completed.id))).toEqual([
      BASE_PROMPT_TOKENS,
      BASE_PROMPT_TOKENS + 10,
    ]);
  });
});
