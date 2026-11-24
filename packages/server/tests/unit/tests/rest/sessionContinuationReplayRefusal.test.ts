import { pendingGenerations } from 'src/lib/agentGenerationHelpers';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  providerFailure,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A session turn paused on a client tool whose continuation the vendor refuses
 * names the window the turn replayed, from memory or rebuilt after a restart.
 */
describe('Session continuation replay refusal', () => {
  let stub: ChatCompletionsStub;
  let token: string;
  let agentId: string;

  const client = () => {
    return authenticatedTestClient(token);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'contrefusal',
      policyActions: [],
      createNoPermUser: false,
    });
    token = setup.adminToken;
    stub = await startChatCompletionsStub();
    const provider = await client().post('/api/v1/ai-providers').send({
      project_id: setup.projectId,
      name: 'Continuation Refusal Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    expect(provider.status).toBe(201);
    const tool = await client()
      .post('/api/v1/tools')
      .send({
        project_id: setup.projectId,
        name: 'read_barometer',
        type: 'client',
        parameters: { type: 'object', properties: {} },
      });
    expect(tool.status).toBe(201);
    const agent = await client()
      .post('/api/v1/agents')
      .send({
        project_id: setup.projectId,
        ai_provider_id: provider.body.id,
        name: 'Continuation Refusal Agent',
        tool_bindings: [{ tool_id: tool.body.id }],
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  /** A session whose second turn is paused on the client tool. */
  const pausedSecondTurn = async () => {
    const session = await client()
      .post('/api/v1/sessions')
      .send({ agent_id: agentId });
    expect(session.status).toBe(201);
    const sessionId = session.body.id as string;
    const say = async () => {
      const sent = await client()
        .post(`/api/v1/sessions/${sessionId}/messages`)
        .send({ message: 'Will it rain?' });
      expect(sent.status).toBeLessThan(300);
    };
    const generate = () => {
      return client().post(`/api/v1/sessions/${sessionId}/generate?wait=true`);
    };
    await say();
    stub.reply(textCompletion('Ask me again.'));
    expect((await generate()).status).toBe(200);
    await say();
    stub.reply(
      toolCallCompletion([{ id: 'call_baro', name: 'read_barometer' }])
    );
    const paused = await generate();
    expect(paused.body.status).toBe('requires_action');
    return { sessionId, generationId: paused.body.generation_id as string };
  };

  describe('POST /api/v1/sessions/{session_id}/tool-outputs', () => {
    test.each([
      ['from memory', false],
      ['after a restart', true],
    ])(
      'a continuation the vendor refuses %s is REPLAY_REFUSED',
      async (_label, restart) => {
        const { sessionId, generationId } = await pausedSecondTurn();
        if (restart) pendingGenerations.delete(generationId);
        stub.reply(providerFailure(400));

        const response = await client()
          .post(`/api/v1/sessions/${sessionId}/tool-outputs`)
          .send({
            generation_id: generationId,
            tool_outputs: [{ tool_call_id: 'call_baro', output: '990 hPa' }],
          });

        expect(response.status).toBe(502);
        expect(response.body.error).toMatchObject({
          code: 'REPLAY_REFUSED',
          meta: {
            cause: 'history_refused',
            replayed_window: { first_position: 0, last_position: 2 },
            generation_id: generationId,
          },
        });
        const generation = await client().get(
          `/api/v1/generations/${generationId}`
        );
        expect(generation.body.error).toMatchObject({
          code: 'REPLAY_REFUSED',
        });
      }
    );

    test('401 without credentials', async () => {
      const response = await testClient
        .post('/api/v1/sessions/sess_missing/tool-outputs')
        .send({
          generation_id: 'gen_missing',
          tool_outputs: [{ tool_call_id: 'call_baro', output: 'x' }],
        });

      expect(response.status).toBe(401);
    });
  });
});
