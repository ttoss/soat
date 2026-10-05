import { pendingGenerations } from 'src/lib/agentGenerationHelpers';

import {
  type ChatCompletionsStub,
  offeredToolNames,
  startChatCompletionsStub,
  systemText,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A paused generation survives a restart: with nothing in the in-memory pending
 * map, `tool-outputs` rebuilds the turn from the persisted `pendingState` —
 * model, config and the whole tool surface, re-resolved for the segment that
 * resumes. Dropping the map entry is what a restart leaves behind.
 */
describe('POST /api/v1/agents/:agent_id/generate/:generation_id/tool-outputs after a restart', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let clientToolId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createAgent = async (body: Record<string, unknown>) => {
    const res = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        max_steps: 4,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const callClientTool = (id: string) => {
    return toolCallCompletion([{ id, name: 'clientTool' }]);
  };

  /** Starts a turn that pauses on the client tool, then forgets it in memory. */
  const pauseAndRestart = async (agentId: string): Promise<string> => {
    const paused = await asAdmin()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('requires_action');
    pendingGenerations.delete(paused.body.id);
    return paused.body.id;
  };

  const submit = (args: {
    agentId: string;
    generationId: string;
    toolCallId: string;
  }) => {
    stub.completions.length = 0;
    return asAdmin()
      .post(
        `/api/v1/agents/${args.agentId}/generate/${args.generationId}/tool-outputs`
      )
      .send({
        tool_outputs: [{ tool_call_id: args.toolCallId, output: 'ok' }],
      });
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'recoveryadmin', password: 'supersecret' });
    adminToken = await loginAs('recoveryadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Generation Recovery Project' });
    projectId = project.body.id;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Recovery Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    aiProviderId = provider.body.id;

    const clientTool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'clientTool',
        type: 'client',
        parameters: { type: 'object', properties: {} },
      });
    expect(clientTool.status).toBe(201);
    clientToolId = clientTool.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  test('resumes on the agent’s own model, config and tools', async () => {
    const agentId = await createAgent({
      name: 'Recovery Agent With Tools',
      instructions: 'Be helpful',
      temperature: 0.7,
      tool_bindings: [{ tool_id: clientToolId }],
    });
    stub.reply(callClientTool('tc_tools'), textCompletion('final answer'));
    const generationId = await pauseAndRestart(agentId);

    const res = await submit({ agentId, generationId, toolCallId: 'tc_tools' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(generationId);
    expect(res.body.status).toBe('completed');
    expect(res.body.output.content).toBe('final answer');
    expect(stub.completions).toHaveLength(1);
    const [resumed] = stub.completions;
    expect(systemText(resumed)).toContain('Be helpful');
    expect(resumed.body.temperature).toBe(0.7);
    expect(offeredToolNames(resumed)).toEqual(['clientTool']);
  });

  // `write_memory` comes from `knowledge_config`, not `tool_bindings`: a
  // resumed segment that lost it would answer without a tool the agent has.
  test('re-resolves the knowledge-derived tools, not only the bound ones', async () => {
    const memoryStore = await asAdmin()
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: 'Recovery Memory Store' });
    expect(memoryStore.status).toBe(201);
    const agentId = await createAgent({
      name: 'Recovery Agent With Memory Store',
      tool_bindings: [{ tool_id: clientToolId }],
      knowledge_config: { write_memory_store_id: memoryStore.body.id },
    });
    stub.reply(callClientTool('tc_memory'), textCompletion('noted'));
    const generationId = await pauseAndRestart(agentId);

    const res = await submit({
      agentId,
      generationId,
      toolCallId: 'tc_memory',
    });

    expect(res.status).toBe(200);
    expect(offeredToolNames(stub.completions[0])).toEqual(
      expect.arrayContaining(['clientTool', 'write_memory'])
    );
  });

  // A binding can be unreachable when the turn resumes. The model is told so
  // once: the same tools being unavailable on both sides of a pause is one
  // fact, however many times the turn is rebuilt.
  test('an unavailable binding is noted once across every resumption', async () => {
    // Port 1 refuses the connection, so the listing fails at the transport.
    const deadMcpTool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'deadDesk',
        type: 'mcp',
        mcp: { url: 'http://127.0.0.1:1/mcp' },
      });
    expect(deadMcpTool.status).toBe(201);
    const agentId = await createAgent({
      name: 'Recovery Agent With Dead MCP',
      tool_bindings: [
        { tool_id: clientToolId },
        { tool_id: deadMcpTool.body.id },
      ],
    });
    stub.reply(
      callClientTool('tc_dead_1'),
      callClientTool('tc_dead_2'),
      textCompletion('done')
    );
    const generationId = await pauseAndRestart(agentId);

    const second = await submit({
      agentId,
      generationId,
      toolCallId: 'tc_dead_1',
    });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('requires_action');
    pendingGenerations.delete(generationId);

    const final = await submit({
      agentId,
      generationId,
      toolCallId: 'tc_dead_2',
    });

    expect(final.status).toBe(200);
    expect(final.body.status).toBe('completed');
    const notes = systemText(stub.completions[0])
      .split('\n')
      .filter((line) => {
        return line.includes('deadDesk') && line.includes('unavailable');
      });
    expect(notes).toHaveLength(1);
  });

  describe('a pause that cannot be rebuilt is a 404', () => {
    // Zero-retention never persists `pendingState`, so a restart loses the
    // pause rather than resuming it from content the mode promised not to keep.
    test('a zero-retention generation has no persisted pause to resume', async () => {
      const agentId = await createAgent({
        name: 'Recovery Zero Retention Agent',
        trace_content_mode: 'none',
        tool_bindings: [{ tool_id: clientToolId }],
      });
      stub.reply(callClientTool('tc_zero'));
      const generationId = await pauseAndRestart(agentId);

      const res = await submit({
        agentId,
        generationId,
        toolCallId: 'tc_zero',
      });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('GENERATION_NOT_FOUND');
    });

    test('a generation answered through another agent', async () => {
      const ownerId = await createAgent({
        name: 'Recovery Owner Agent',
        tool_bindings: [{ tool_id: clientToolId }],
      });
      const otherId = await createAgent({ name: 'Recovery Other Agent' });
      stub.reply(callClientTool('tc_owner'));
      const generationId = await pauseAndRestart(ownerId);

      const res = await submit({
        agentId: otherId,
        generationId,
        toolCallId: 'tc_owner',
      });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('GENERATION_NOT_FOUND');
    });
  });
});
