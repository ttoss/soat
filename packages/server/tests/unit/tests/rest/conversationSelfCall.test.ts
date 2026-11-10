import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  type RecordedRequest,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

/**
 * A conversation turn's `builtin` calls run as the caller of
 * `POST /conversations/{id}/generate`, and the generation records that caller
 * as `acted_as`.
 */

const BUILTIN_CALL_ID = 'call_conversation_builtin';

const builtinToolResult = (completions: RecordedRequest[]): string => {
  for (const request of completions) {
    const messages = request.body.messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        message.role === 'tool' &&
        'tool_call_id' in message &&
        message.tool_call_id === BUILTIN_CALL_ID
      ) {
        return JSON.stringify(message);
      }
    }
  }
  return '';
};

describe('Conversation self-call', () => {
  let stub: ChatCompletionsStub;
  let userToken: string;
  let userId: string;
  let adminToken: string;
  let projectId: string;
  let agentId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'convselfcall',
      policyActions: [
        'conversations:CreateConversation',
        'conversations:UpdateConversation',
        'conversations:GenerateConversationMessage',
        'tools:ListTools',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    userId = setup.userId;
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    const asAdmin = authenticatedTestClient(setup.adminToken);

    stub = await startChatCompletionsStub();
    const provider = await asAdmin.post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'conversation-self-call-stub',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    expect(provider.status).toBe(201);

    const builtin = await asAdmin.post('/api/v1/tools').send({
      project_id: projectId,
      name: 'conversation-self-call-tool',
      type: 'builtin',
      actions: ['list-tools'],
    });
    expect(builtin.status).toBe(201);

    const agent = await asAdmin.post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: provider.body.id,
      name: 'conversation-self-call-agent',
      tool_bindings: [{ tool_id: builtin.body.id }],
    });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  test('POST /conversations/{id}/generate runs its builtin calls as the caller and records it', async () => {
    const asUser = authenticatedTestClient(userToken);
    const conversation = await asUser
      .post('/api/v1/conversations')
      .send({ project_id: projectId });
    expect(conversation.status).toBe(201);
    const message = await asUser
      .post(`/api/v1/conversations/${conversation.body.id}/messages`)
      .send({ message: 'List the tools.', role: 'user' });
    expect(message.status).toBe(201);
    stub.reply(
      toolCallCompletion([
        {
          id: BUILTIN_CALL_ID,
          name: 'conversation-self-call-tool_list-tools',
          args: { project_id: projectId },
        },
      ]),
      textCompletion('done')
    );

    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/conversations/${conversation.body.id}/generate?wait=true`)
      .send({ agent_id: agentId });

    expect(res.status).toBe(200);
    const result = builtinToolResult(stub.completions);
    expect(result).not.toBe('');
    expect(result).not.toContain('HttpToolError');
    expect(result).toContain('conversation-self-call-tool');
    const generation = await authenticatedTestClient(adminToken).get(
      `/api/v1/generations/${res.body.generation_id}`
    );
    expect(generation.body.acted_as).toEqual({
      principal_type: 'user',
      principal_id: userId,
    });
  });
});
