import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A decision on a tool call proposed inside a session is fed back into that
 * session's own thread: the continuation is a message appended to the
 * session's conversation, then a turn generated over it — not a standalone
 * generation the session never sees.
 */
describe('POST /api/v1/approvals/:approval_id/reject on a session-backed tool call', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let projectId: string;
  let sessionId: string;
  let conversationId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const conversationTexts = async (): Promise<string[]> => {
    const res = await asAdmin().get(
      `/api/v1/conversations/${conversationId}/messages`
    );
    expect(res.status).toBe(200);
    return res.body.data.map((message: { content: string }) => {
      return message.content;
    });
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/refunds': () => {
          return { body: { refunded: true } };
        },
      },
    });

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'apprsessadmin', password: 'supersecret' });
    adminToken = await loginAs('apprsessadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Approval Session Project' });
    projectId = project.body.id;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Approval Session Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });

    const guardrail = await asAdmin()
      .post('/api/v1/guardrails')
      .send({
        project_id: projectId,
        name: 'Refunds Need Sign-off',
        document: { class: 'C' },
      });
    expect(guardrail.status).toBe(201);

    const tool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'refund_order',
        type: 'http',
        description: 'Refunds an order.',
        parameters: {
          type: 'object',
          properties: { order_id: { type: 'string' } },
        },
        execute: { url: `${stub.baseUrl}/refunds`, method: 'POST' },
        guardrail_ids: [guardrail.body.id],
      });
    expect(tool.status).toBe(201);

    const agent = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Approval Session Agent',
        tool_bindings: [{ tool_id: tool.body.id }],
        max_steps: 3,
      });
    expect(agent.status).toBe(201);

    const session = await asAdmin()
      .post('/api/v1/sessions')
      .send({ agent_id: agent.body.id });
    expect(session.status).toBe(201);
    sessionId = session.body.id;
    conversationId = session.body.conversation_id;
  });

  afterAll(async () => {
    await stub.close();
  });

  test('the decision is appended to the session conversation and answered there', async () => {
    const message = await asAdmin()
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .send({ message: 'Refund order 7' });
    expect(message.status).toBe(201);

    stub.reply(
      toolCallCompletion([
        {
          id: 'call_refund',
          name: 'refund_order',
          args: { order_id: '7', approval_reasoning: 'customer asked' },
        },
      ]),
      textCompletion('Waiting for sign-off.'),
      textCompletion('The refund was declined.')
    );
    const turn = await asAdmin().post(
      `/api/v1/sessions/${sessionId}/generate?wait=true`
    );
    expect(turn.status).toBe(200);

    const pending = await asAdmin()
      .get('/api/v1/approvals')
      .query({ project_id: projectId, status: 'pending' });
    expect(pending.status).toBe(200);
    expect(pending.body.data).toHaveLength(1);
    const [approval] = pending.body.data;
    expect(approval.session_id).toBe(sessionId);

    const rejected = await asAdmin()
      .post(`/api/v1/approvals/${approval.id}/reject`)
      .send({ reason: 'over the refund limit' });
    expect(rejected.status).toBe(200);

    // The continuation is fired after the response, so the thread is read
    // once the continuation's own answer has landed in it.
    let texts: string[] = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      texts = await conversationTexts();
      if (texts.includes('The refund was declined.')) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }

    const decision = texts.find((text) => {
      return text.startsWith(`Approval ${approval.id} `);
    });
    expect(decision).toContain('was rejected');
    expect(decision).toContain('over the refund limit');
    expect(texts.indexOf(decision ?? '')).toBeLessThan(
      texts.indexOf('The refund was declined.')
    );
  });
});
