import { pendingGenerations } from 'src/lib/agentGenerationHelpers';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  offeredToolNames,
  type RecordedRequest,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

/** The `role: "tool"` contents a recorded completion request carries. */
const toolResultTexts = (request: RecordedRequest): string[] => {
  const messages = request.body.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) => {
    if (typeof message !== 'object' || message === null) return [];
    if (!('role' in message) || message.role !== 'tool') return [];
    return 'content' in message && typeof message.content === 'string'
      ? [message.content]
      : [];
  });
};

/**
 * The continuation of a paused generation calls tools on the credential of the
 * caller who submits its tool outputs, whether the pause is still in memory or
 * rebuilt from the database: the submitter never borrows the starter's.
 */
describe('POST /api/v1/agents/:agent_id/generate/:generation_id/tool-outputs credential', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let userToken: string;
  let agentId: string;
  let listToolsName: string;

  beforeAll(async () => {
    stub = await startChatCompletionsStub();

    // The submitter may answer the generation but not list tools, which only
    // the starter (the admin) may do.
    const setup = await setupProjectWithUsers({
      prefix: 'tooloutcred',
      policyActions: [
        'agents:GetAgent',
        'agents:CreateAgentGeneration',
        'tools:CallTool',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;

    const asAdmin = authenticatedTestClient(adminToken);
    const provider = await asAdmin.post('/api/v1/ai-providers').send({
      project_id: setup.projectId,
      name: 'Credential Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    expect(provider.status).toBe(201);

    const clientTool = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: setup.projectId,
        name: 'clientTool',
        type: 'client',
        parameters: { type: 'object', properties: {} },
      });
    expect(clientTool.status).toBe(201);

    const listTools = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: setup.projectId,
        name: 'credListTools',
        type: 'builtin',
        actions: ['list-tools'],
      });
    expect(listTools.status).toBe(201);

    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: setup.projectId,
        ai_provider_id: provider.body.id,
        name: 'Credential Agent',
        max_steps: 4,
        tool_bindings: [
          { tool_id: clientTool.body.id },
          { tool_id: listTools.body.id },
        ],
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  /** The admin starts a turn that pauses on the client tool. */
  const pauseAsAdmin = async (): Promise<string> => {
    stub.reply(toolCallCompletion([{ id: 'tc_client', name: 'clientTool' }]));
    stub.completions.length = 0;
    const paused = await authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('requires_action');
    listToolsName ??= offeredToolNames(stub.completions[0]).find((name) => {
      return name !== 'clientTool';
    }) as string;
    return paused.body.id;
  };

  /** The user answers it, and the continuation calls the list-tools action. */
  const submitAsUser = async (generationId: string) => {
    stub.reply(
      toolCallCompletion([
        { id: 'tc_list', name: listToolsName, args: { action: 'list-tools' } },
      ]),
      textCompletion('done')
    );
    stub.completions.length = 0;
    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate/${generationId}/tool-outputs`)
      .send({ tool_outputs: [{ tool_call_id: 'tc_client', output: 'ok' }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    const [, afterToolCall] = stub.completions;
    return toolResultTexts(afterToolCall).join('\n');
  };

  test('a pause still in memory runs its tools as the submitter', async () => {
    const generationId = await pauseAsAdmin();
    expect(pendingGenerations.has(generationId)).toBe(true);

    const toolResult = await submitAsUser(generationId);

    expect(toolResult).not.toContain('credListTools');
    expect(toolResult).toContain("'list-tools' failed");
  });

  test('a pause rebuilt from the database runs its tools as the submitter', async () => {
    const generationId = await pauseAsAdmin();
    pendingGenerations.delete(generationId);

    const toolResult = await submitAsUser(generationId);

    expect(toolResult).not.toContain('credListTools');
    expect(toolResult).toContain("'list-tools' failed");
  });
});
