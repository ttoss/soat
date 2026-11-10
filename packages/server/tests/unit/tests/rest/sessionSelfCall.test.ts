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
 * A session turn's `builtin` calls run as the caller of the route that drove
 * the turn: each session route that runs a generation forwards its credential.
 */

const BUILTIN_CALL_ID = 'call_session_builtin';

/**
 * The tool result the model was handed for the builtin call. A refused
 * self-call still completes the generation, so this is the assertion.
 */
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

describe('Session self-call', () => {
  let stub: ChatCompletionsStub;
  let userToken: string;
  let userId: string;
  let adminToken: string;
  let projectId: string;
  let agentId: string;
  let builtinCall: { id: string; name: string; args: Record<string, unknown> };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'sessselfcall',
      policyActions: [
        'agents:CreateSession',
        'agents:SendSessionMessage',
        'agents:SubmitSessionToolOutputs',
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
      name: 'session-self-call-stub',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    expect(provider.status).toBe(201);

    const builtin = await asAdmin.post('/api/v1/tools').send({
      project_id: projectId,
      name: 'session-self-call-tool',
      type: 'builtin',
      actions: ['list-tools'],
    });
    expect(builtin.status).toBe(201);
    const client = await asAdmin.post('/api/v1/tools').send({
      project_id: projectId,
      name: 'session_self_call_client',
      type: 'client',
      parameters: { type: 'object', properties: {} },
    });
    expect(client.status).toBe(201);

    const agent = await asAdmin.post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: provider.body.id,
      name: 'session-self-call-agent',
      tool_bindings: [
        { tool_id: builtin.body.id },
        { tool_id: client.body.id },
      ],
    });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;

    builtinCall = {
      id: BUILTIN_CALL_ID,
      name: 'session-self-call-tool_list-tools',
      args: { project_id: projectId },
    };
  });

  afterAll(async () => {
    await stub.close();
  });

  const createSession = async (body: Record<string, unknown> = {}) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const expectAuthenticatedBuiltinCall = () => {
    const result = builtinToolResult(stub.completions);
    expect(result).not.toBe('');
    expect(result).not.toContain('HttpToolError');
    expect(result).toContain('session-self-call-tool');
  };

  beforeEach(() => {
    stub.completions.length = 0;
  });

  test('POST /sessions/{id}/generate runs its builtin calls as the caller', async () => {
    const sessionId = await createSession();
    await authenticatedTestClient(userToken)
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .send({ message: 'List the tools.' });
    stub.reply(toolCallCompletion([builtinCall]), textCompletion('done'));

    const res = await authenticatedTestClient(userToken).post(
      `/api/v1/sessions/${sessionId}/generate?wait=true`
    );

    expect(res.status).toBe(200);
    expectAuthenticatedBuiltinCall();
  });

  test('POST /sessions/{id}/messages runs an auto-generated turn as the caller', async () => {
    const sessionId = await createSession({ auto_generate: true });
    stub.reply(toolCallCompletion([builtinCall]), textCompletion('done'));

    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .send({ message: 'List the tools.' });

    expect(res.status).toBe(201);
    expectAuthenticatedBuiltinCall();
  });

  test('POST /sessions/{id}/tool-outputs resumes the turn as the caller', async () => {
    const sessionId = await createSession();
    await authenticatedTestClient(userToken)
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .send({ message: 'Ask me first, then list the tools.' });
    stub.reply(
      toolCallCompletion([
        { id: 'call_session_client', name: 'session_self_call_client' },
      ]),
      toolCallCompletion([builtinCall]),
      textCompletion('done')
    );
    const paused = await authenticatedTestClient(userToken).post(
      `/api/v1/sessions/${sessionId}/generate?wait=true`
    );
    expect(paused.body.status).toBe('requires_action');

    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/sessions/${sessionId}/tool-outputs`)
      .send({
        generation_id: paused.body.generation_id,
        tool_outputs: [{ tool_call_id: 'call_session_client', output: 'ok' }],
      });

    expect(res.status).toBe(200);
    expectAuthenticatedBuiltinCall();
    const generation = await authenticatedTestClient(adminToken).get(
      `/api/v1/generations/${paused.body.generation_id}`
    );
    expect(generation.body.acted_as).toEqual({
      principal_type: 'user',
      principal_id: userId,
    });
  });
});
