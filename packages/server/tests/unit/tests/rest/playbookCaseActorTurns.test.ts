import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import { setupProjectWithUsers, testGrant } from '../../fixtures/bootstrap';
import {
  type ChatRequest,
  createTurnScript,
  requestsOfTurn,
  startChatCompletionStub,
  toolResultsOf,
} from '../../fixtures/chatCompletionStub';
import { createPlaybookCase } from '../../fixtures/playbookCase';
import { startToolTarget, type ToolTarget } from '../../fixtures/scriptedModel';
import { authenticatedTestClient } from '../../testClient';

/**
 * A node of a case with an actor starts its generations for that actor, as a
 * session of the actor does: retrieval reads the actor's memories, a memory
 * the turn writes is the actor's, and its tool calls carry the actor's
 * identity. Generations an orchestration executor starts run for it too.
 */
const script = createTurnScript();
const stubPromise = startChatCompletionStub({ reply: script.reply });

describe('Playbook case nodes run as the case actor', () => {
  let target: ToolTarget;
  let adminToken: string;
  let projectId: string;
  let providerId: string;
  let actorA: string;
  let actorB: string;
  let storeId: string;
  let memoryA: string;
  let memoryB: string;
  let toolName: string;
  let agentId: string;
  let agentPlaybookId: string;
  let orchestrationAgentId: string;
  let orchestrationPlaybookId: string;

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

  const promptPlaybook = async (executor: Record<string, unknown>) => {
    return create('/api/v1/playbooks', {
      policy_ids: await testGrant({ token: adminToken }),
      name: `actor-turns-${crypto.randomUUID()}`,
      definition: {
        nodes: [
          {
            id: 'ask',
            title: 'Ask',
            kind: 'execute',
            inputs: [
              {
                name: 'prompt',
                schema: { type: 'string' },
                required: true,
                source: 'manual',
              },
            ],
            executor,
          },
        ],
      },
    });
  };

  /** Runs the `ask` node of a new case of `actorId` on `prompt`. */
  const runCase = async (args: {
    playbookId: string;
    actorId?: string;
    prompt: string;
  }) => {
    const created = await createPlaybookCase({
      client: asAdmin(),
      playbookId: args.playbookId,
      body: {
        subject: `case-${crypto.randomUUID()}`,
        ...(args.actorId ? { actor_id: args.actorId } : {}),
      },
    });
    expect(created.status).toBe(201);
    const caseId = created.body.id as string;
    const written = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: [
          {
            node_id: 'ask',
            name: 'prompt',
            value: args.prompt,
            expected_revision: null,
          },
        ],
      });
    expect(written.status).toBe(200);
    await flushPlaybookExecutions();
    const executions = await asAdmin().get(
      `/api/v1/playbook-cases/${caseId}/executions?limit=100`
    );
    expect(executions.body.data[0].status).toBe('completed');
  };

  /** Runs one agent-node turn whose model calls `calls`; its requests. */
  const agentTurn = async (args: {
    actorId?: string;
    calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  }): Promise<ChatRequest[]> => {
    const marker = script.arm(args.calls);
    await runCase({
      playbookId: agentPlaybookId,
      actorId: args.actorId,
      prompt: `What do we know? ${marker}`,
    });
    return requestsOfTurn({
      requests: (await stubPromise).requests,
      marker,
    });
  };

  const injected = (requests: ChatRequest[]): string => {
    const block = requests[0].messages.find((message) => {
      return (
        typeof message.content === 'string' &&
        message.content.includes('<knowledge>')
      );
    });
    return typeof block?.content === 'string' ? block.content : '';
  };

  const generationActors = async (forAgentId: string) => {
    const res = await asAdmin().get(
      `/api/v1/generations?agent_id=${forAgentId}&limit=100`
    );
    expect(res.status).toBe(200);
    return res.body.data.map((generation: { actor_id: string | null }) => {
      return generation.actor_id;
    });
  };

  beforeAll(async () => {
    target = await startToolTarget();
    const setup = await setupProjectWithUsers({
      prefix: 'playbookactorturns',
      policyActions: [],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    providerId = await create('/api/v1/ai-providers', {
      name: 'stub',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: (await stubPromise).baseUrl,
    });
    actorA = await create('/api/v1/actors', { name: 'A' });
    actorB = await create('/api/v1/actors', { name: 'B' });
    storeId = await create('/api/v1/memory-stores', { name: 'people' });
    const remember = async (content: string, actorId: string) => {
      const res = await asAdmin()
        .post('/api/v1/memories')
        .send({ memory_store_id: storeId, content, actor_id: actorId });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    memoryA = await remember('A prefers email.', actorA);
    memoryB = await remember('B prefers phone.', actorB);

    toolName = `whoami_${crypto.randomUUID().slice(0, 8)}`;
    const toolId = await create('/api/v1/tools', {
      name: toolName,
      type: 'http',
      parameters: { type: 'object', properties: {} },
      execute: { url: `${target.baseUrl}/${toolName}`, method: 'POST' },
    });
    agentId = await create('/api/v1/agents', {
      ai_provider_id: providerId,
      name: 'actor-turns-agent',
      max_steps: 3,
      knowledge_config: {
        memory_store_ids: [storeId],
        write_memory_store_id: storeId,
      },
      tool_bindings: [{ tool_id: toolId }],
    });
    agentPlaybookId = await promptPlaybook({ type: 'agent', id: agentId });

    orchestrationAgentId = await create('/api/v1/agents', {
      ai_provider_id: providerId,
      name: 'actor-turns-orchestration-agent',
    });
    const orchestrationId = await create('/api/v1/orchestrations', {
      name: 'actor-turns-orchestration',
      nodes: [
        {
          id: 'answer',
          type: 'agent',
          agent_id: orchestrationAgentId,
          input_mapping: { prompt: { var: 'prompt' } },
        },
      ],
      edges: [],
    });
    orchestrationPlaybookId = await promptPlaybook({
      type: 'orchestration',
      id: orchestrationId,
    });
  });

  afterAll(async () => {
    await (await stubPromise).close();
    await target.close();
  });

  describe('POST /api/v1/playbook-cases/{case_id}/inputs', () => {
    test("an agent node retrieves only the case actor's memories", async () => {
      const text = injected(await agentTurn({ actorId: actorA, calls: [] }));

      expect(text).toContain(memoryA);
      expect(text).not.toContain(memoryB);
    });

    test("a memory an agent node writes is the case actor's", async () => {
      const requests = await agentTurn({
        actorId: actorA,
        calls: [
          { name: 'write_memory', arguments: { content: 'A is vegan.' } },
        ],
      });

      const { memoryId } = JSON.parse(
        toolResultsOf(requests[requests.length - 1])[0]
      ) as { memoryId: string };
      const memory = await asAdmin().get(`/api/v1/memories/${memoryId}`);
      expect(memory.body.actor_id).toBe(actorA);
    });

    test("an agent node's tool call carries the case actor", async () => {
      await agentTurn({
        actorId: actorA,
        calls: [{ name: toolName, arguments: {} }],
      });

      const [request] = target.requestsAt(`/${toolName}`).slice(-1);
      expect(request.headers['x-soat-context-actor_id']).toBe(actorA);
    });

    test('an agent node of a case with no actor runs for no actor', async () => {
      const text = injected(await agentTurn({ calls: [] }));

      expect(text).toContain(memoryA);
      expect(text).toContain(memoryB);
    });

    test("an orchestration node's agent runs for the case actor", async () => {
      await runCase({
        playbookId: orchestrationPlaybookId,
        actorId: actorB,
        prompt: 'hello',
      });

      expect(await generationActors(orchestrationAgentId)).toEqual([actorB]);
    });
  });
});
