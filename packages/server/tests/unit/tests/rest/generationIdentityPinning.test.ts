import {
  type ChatCompletionsStub,
  type RecordedRequest,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The identity keys of a turn's tool context (`session_id`, `actor_id`,
 * `actor_external_id`) are the server's to set, never the caller's: they reach
 * every tool call as `x-soat-context-*` headers a downstream service trusts.
 * Asserted on the headers the tool actually receives, on a path with no
 * session and on a session's.
 */
describe('tool context identity keys on a generation', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let agentId: string;
  let sessionId: string;
  let actorId: string;
  const actorExternalId = '+15559876543';

  const FORGED = {
    session_id: 'ses_forged',
    actor_id: 'act_forged',
    actor_external_id: 'forged-external',
    userId: 'usr_legit',
  };

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  /** Runs the turn and returns the request its one tool call made. */
  const toolRequestOf = async (
    run: () => Promise<{ status: number }>
  ): Promise<RecordedRequest> => {
    stub.routeRequests.length = 0;
    stub.reply(
      toolCallCompletion([{ id: 'call_lookup', name: 'lookup_order' }]),
      textCompletion('Found it.')
    );
    const res = await run();
    expect(res.status).toBe(200);
    expect(stub.routeRequests).toHaveLength(1);
    return stub.routeRequests[0];
  };

  const generate = (toolContext: Record<string, string>) => {
    return asAdmin()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: 'Where is my order?' }],
        tool_context: toolContext,
      });
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/lookup': () => {
          return { body: { status: 'shipped' } };
        },
      },
    });

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'ctxpinadmin', password: 'supersecret' });
    adminToken = await loginAs('ctxpinadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Identity Pinning Project' });
    const projectId = project.body.id;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Identity Pinning Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });

    const tool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'lookup_order',
        type: 'http',
        description: 'Looks an order up.',
        parameters: { type: 'object', properties: {} },
        execute: { url: `${stub.baseUrl}/lookup`, method: 'POST' },
      });
    expect(tool.status).toBe(201);

    const agent = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Identity Pinning Agent',
        tool_bindings: [{ tool_id: tool.body.id }],
        max_steps: 3,
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;

    const actor = await asAdmin().post('/api/v1/actors').send({
      project_id: projectId,
      name: 'Identity Pinning Actor',
      external_id: actorExternalId,
    });
    actorId = actor.body.id;

    const session = await asAdmin()
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, actor_id: actorId });
    expect(session.status).toBe(201);
    sessionId = session.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('a forged identity is stripped and the rest of the bag forwarded', async () => {
      const { headers } = await toolRequestOf(() => {
        return generate(FORGED);
      });

      expect(headers['x-soat-context-userid']).toBe('usr_legit');
      expect(headers['x-soat-context-session_id']).toBeUndefined();
      expect(headers['x-soat-context-actor_id']).toBeUndefined();
      expect(headers['x-soat-context-actor_external_id']).toBeUndefined();
    });

    // Header names are case-insensitive, so a casing variant would land on
    // the very header the strip exists to keep.
    test('a casing variant of a reserved key is stripped too', async () => {
      const { headers } = await toolRequestOf(() => {
        return generate({ Session_ID: 'ses_forged', ACTOR_ID: 'act_forged' });
      });

      expect(headers['x-soat-context-session_id']).toBeUndefined();
      expect(headers['x-soat-context-actor_id']).toBeUndefined();
    });
  });

  describe('POST /api/v1/sessions/:session_id/generate', () => {
    test("the session's own identity is stamped over a forged bag", async () => {
      const message = await asAdmin()
        .post(`/api/v1/sessions/${sessionId}/messages`)
        .send({ message: 'Where is my order?' });
      expect(message.status).toBe(201);

      const { headers } = await toolRequestOf(() => {
        return asAdmin()
          .post(`/api/v1/sessions/${sessionId}/generate?wait=true`)
          .send({ tool_context: FORGED });
      });

      expect(headers['x-soat-context-userid']).toBe('usr_legit');
      expect(headers['x-soat-context-session_id']).toBe(sessionId);
      expect(headers['x-soat-context-actor_id']).toBe(actorId);
      expect(headers['x-soat-context-actor_external_id']).toBe(actorExternalId);
    });
  });
});
