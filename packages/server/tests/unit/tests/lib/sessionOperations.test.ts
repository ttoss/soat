import { db } from 'src/db';
import { sendSessionMessage } from 'src/lib/sessionOperations';

import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// `sendSessionMessage` combines addSessionMessage + generateSessionResponse
// into a single call. It has no REST route of its own (the REST layer calls
// the two steps separately), so it is exercised directly here.
describe('sendSessionMessage', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let agentPublicId: string;
  let internalAgentId: number;
  let sessionId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'sendSessionMessage Test Project' });
    projectId = projectRes.body.id;

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'sendSessionMessage Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProviderRes.body.id;

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'sendSessionMessage Test Agent',
      });
    agentPublicId = agentRes.body.id;

    const agent = await db.Agent.findOne({
      where: { publicId: agentPublicId },
    });
    internalAgentId = agent!.id as number;

    const sessionRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/sessions')
      .send({ agent_id: agentPublicId, name: 'sendSessionMessage Test' });
    sessionId = sessionRes.body.id;
  });

  test('adds the user message and returns the generated response', async () => {
    mockCreateGeneration.mockResolvedValueOnce({
      id: 'gen_send_01',
      traceId: 'trc_send_01',
      status: 'completed',
      output: { model: 'test-model', content: 'Reply', finishReason: 'stop' },
    });

    const result = await sendSessionMessage({
      agentId: internalAgentId,
      sessionId,
      message: 'Hello from sendSessionMessage',
    });

    expect(result.status).toBe('completed');

    const messagesRes = await authenticatedTestClient(adminToken).get(
      `/api/v1/sessions/${sessionId}`
    );
    const conversationMessagesRes = await authenticatedTestClient(
      adminToken
    ).get(`/api/v1/conversations/${messagesRes.body.conversation_id}/messages`);
    const userMessage = conversationMessagesRes.body.data.find(
      (m: { content: string }) => {
        return m.content === 'Hello from sendSessionMessage';
      }
    );
    expect(userMessage).toBeDefined();
  });
});
