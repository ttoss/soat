import { agentRefusal } from '../../fixtures/agentRefusal';
import { pollUntil } from '../../fixtures/agentToolTurn';
import {
  createTurnScript,
  requestsOfTurn,
  startChatCompletionStub,
  toolResultsOf,
} from '../../fixtures/chatCompletionStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A `write_memory` call is a native tool call: each one that runs records a
 * `tool_execution` usage event, so the `runtime.*.tool_calls` counters a guard
 * reads count it like an outbound call. Only the model is stubbed.
 */
const script = createTurnScript();

const stubPromise = startChatCompletionStub({ reply: script.reply });

const TRIPWIRE = {
  status: 'tripwire',
  reason:
    'A guardrail tripwire fired: a class-B guard failed and the action was aborted.',
};

const ceiling = (key: string, limit: number) => {
  return { class: 'B', guard: { '<': [{ var: key }, limit] } };
};

describe('write_memory usage', () => {
  let adminToken: string;
  let projectId: string;
  let providerId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin().post(path).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const unique = (label: string) => {
    return `${label}-${Math.random().toString(36).slice(2)}`;
  };

  const createGuardrail = (document: Record<string, unknown>) => {
    return create('/api/v1/guardrails', {
      project_id: projectId,
      name: unique('gate'),
      document,
    });
  };

  const createAgent = async (args: {
    guardrailIds?: string[];
    agentPolicy?: Record<string, unknown>;
    targetProjectId?: string;
    targetProviderId?: string;
  }) => {
    const target = args.targetProjectId ?? projectId;
    const writeStoreId = await create('/api/v1/memory-stores', {
      project_id: target,
      name: unique('notes'),
    });
    const agentId = await create('/api/v1/agents', {
      project_id: target,
      ai_provider_id: args.targetProviderId ?? providerId,
      name: unique('agent'),
      instructions: 'Remember what you are told.',
      max_steps: 3,
      knowledge_config: { write_memory_store_id: writeStoreId },
      ...(args.guardrailIds ? { guardrail_ids: args.guardrailIds } : {}),
      ...(args.agentPolicy
        ? {
            policy_ids: [
              await create('/api/v1/policies', {
                document: args.agentPolicy,
              }),
            ],
          }
        : {}),
    });
    return { agentId, writeStoreId };
  };

  /** One turn whose model asks to remember `content`; the tool's answer. */
  const remember = async (args: { agentId: string; content: string }) => {
    const stub = await stubPromise;
    const marker = script.arm([
      { name: 'write_memory', arguments: { content: args.content } },
    ]);
    const res = await asAdmin()
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: `Note this down. ${marker}` }],
      });
    expect(res.status).toBe(200);
    const requests = requestsOfTurn({ requests: stub.requests, marker });
    const [result] = toolResultsOf(requests[requests.length - 1]);
    return {
      generationId: res.body.id as string,
      result: JSON.parse(result) as Record<string, unknown>,
    };
  };

  const toolExecutionsOf = async (generationId: string) => {
    const res = await asAdmin().get(
      `/api/v1/usage/events?generation_id=${generationId}&meter_type=tool_execution`
    );
    expect(res.status).toBe(200);
    return res.body.data as Array<Record<string, unknown>>;
  };

  const createProvider = async (target: string) => {
    const { baseUrl } = await stubPromise;
    return create('/api/v1/ai-providers', {
      project_id: target,
      name: unique('provider'),
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: baseUrl,
    });
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'writememoryusageadmin', password: 'supersecret' });
    adminToken = await loginAs('writememoryusageadmin', 'supersecret');
    projectId = await create('/api/v1/projects', {
      name: 'Write memory usage',
    });
    providerId = await createProvider(projectId);
  });

  afterAll(async () => {
    await (await stubPromise).close();
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('an executed write is a tool_execution event of its turn, unpriced', async () => {
      const { agentId } = await createAgent({});

      const { generationId, result } = await remember({
        agentId,
        content: 'The deploy window is Tuesday.',
      });

      expect(result.action).toBe('created');
      expect(await toolExecutionsOf(generationId)).toEqual([
        expect.objectContaining({
          meter_type: 'tool_execution',
          tool_id: 'native:write_memory',
          generation_id: generationId,
          agent_id: agentId,
          outcome: 'ok',
          cost_usd: null,
          components: [],
        }),
      ]);
    });

    test('runtime.guardrails.tool_calls lets two writes through and trips the third', async () => {
      const { agentId } = await createAgent({
        guardrailIds: [
          await createGuardrail(ceiling('runtime.guardrails.tool_calls.1h', 2)),
        ],
      });

      const first = await remember({ agentId, content: 'First fact.' });
      const second = await remember({ agentId, content: 'Second fact.' });
      const third = await remember({ agentId, content: 'Third fact.' });

      expect(first.result.action).toBeDefined();
      expect(second.result.action).toBeDefined();
      expect(third.result).toEqual(TRIPWIRE);
      expect(await toolExecutionsOf(third.generationId)).toEqual([]);
    });

    // The tool is every agent's in the project, so the count is too: the test
    // gets a project of its own.
    test('runtime.tools.tool_calls counts the native tool', async () => {
      const ownProjectId = await create('/api/v1/projects', {
        name: unique('Write memory tool count'),
      });
      const { agentId } = await createAgent({
        targetProjectId: ownProjectId,
        targetProviderId: await createProvider(ownProjectId),
        guardrailIds: [
          await create('/api/v1/guardrails', {
            project_id: ownProjectId,
            name: unique('gate'),
            document: ceiling('runtime.tools.tool_calls.1h', 1),
          }),
        ],
      });

      const first = await remember({ agentId, content: 'A tool fact.' });
      const second = await remember({ agentId, content: 'Another one.' });

      expect(first.result.action).toBe('created');
      expect(second.result).toEqual(TRIPWIRE);
    });

    test('a write the boundary denies records no event', async () => {
      const { agentId } = await createAgent({
        agentPolicy: {
          statement: [{ effect: 'Deny', action: ['*'], resource: ['*'] }],
        },
      });

      const { generationId, result } = await remember({
        agentId,
        content: 'A refused fact.',
      });

      expect(result).toEqual(
        agentRefusal({ agentId, action: 'memories:CreateMemory' })
      );
      expect(await toolExecutionsOf(generationId)).toEqual([]);
    });

    test('a write a guardrail blocks records no event', async () => {
      const { agentId } = await createAgent({
        guardrailIds: [await createGuardrail({ class: 'D' })],
      });

      const { generationId, result } = await remember({
        agentId,
        content: 'A blocked fact.',
      });

      expect(result.status).toBe('blocked');
      expect(await toolExecutionsOf(generationId)).toEqual([]);
    });
  });

  describe('POST /api/v1/approvals/:approval_id/approve', () => {
    test('an approved write is a tool_execution event of the proposing turn', async () => {
      const gatedProjectId = await create('/api/v1/projects', {
        name: unique('Write memory sign-off'),
      });
      const attached = await asAdmin()
        .patch(`/api/v1/projects/${gatedProjectId}`)
        .send({
          guardrail_ids: [
            await create('/api/v1/guardrails', {
              project_id: gatedProjectId,
              name: unique('hold'),
              document: { class: 'C' },
            }),
          ],
        });
      expect(attached.status).toBe(200);
      const { agentId, writeStoreId } = await createAgent({
        targetProjectId: gatedProjectId,
        targetProviderId: await createProvider(gatedProjectId),
      });
      const { generationId, result } = await remember({
        agentId,
        content: 'Invoices are due in 30 days.',
      });
      expect(await toolExecutionsOf(generationId)).toEqual([]);

      const approved = await asAdmin()
        .post(`/api/v1/approvals/${result.approval_id as string}/approve`)
        .send({});
      expect(approved.status).toBe(200);

      // The decision runs after the response; its event is written once the
      // write returns.
      const executions = await pollUntil({
        read: () => {
          return toolExecutionsOf(generationId);
        },
        done: (events) => {
          return events.length > 0;
        },
      });
      expect(executions).toEqual([
        expect.objectContaining({
          tool_id: 'native:write_memory',
          generation_id: generationId,
          agent_id: agentId,
          outcome: 'ok',
        }),
      ]);
      const written = await asAdmin().get(
        `/api/v1/memories?memory_store_id=${writeStoreId}`
      );
      expect(written.body.data).toHaveLength(1);
    });
  });
});
