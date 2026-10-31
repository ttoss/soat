import { pendingGenerations } from 'src/lib/agentGenerationHelpers';

import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A grantee's turn on a shared agent that paused on a client tool is answered
 * by the grantee, from memory or rebuilt after a restart, and resumes in the
 * grantee project it started in.
 */
describe('Tool outputs for a shared agent', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;
  let otherKey: string;
  let agentId: string;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const grantee = () => {
    return authenticatedTestClient(granteeKey);
  };

  const pause = async (args: { toolCallId: string; restart: boolean }) => {
    stub.reply(
      toolCallCompletion([{ id: args.toolCallId, name: 'clientTool' }]),
      textCompletion('resumed answer')
    );
    const paused = await grantee()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('requires_action');
    if (args.restart) pendingGenerations.delete(paused.body.id);
    return paused.body.id as string;
  };

  const submit = (args: {
    key: string;
    generationId: string;
    toolCallId: string;
  }) => {
    return authenticatedTestClient(args.key)
      .post(
        `/api/v1/agents/${agentId}/generate/${args.generationId}/tool-outputs`
      )
      .send({
        tool_outputs: [{ tool_call_id: args.toolCallId, output: 'ok' }],
      });
  };

  const meteredProjects = async (generationId: string) => {
    const events = await admin().get('/api/v1/usage/events').query({
      meter_type: 'llm_tokens',
      generation_id: generationId,
    });
    expect(events.status).toBe(200);
    return events.body.data.map((event: { project_id: string }) => {
      return event.project_id;
    });
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'sharedtooloutputs', password: 'supersecret' });
    adminToken = await loginAs('sharedtooloutputs', 'supersecret');

    publisherId = (
      await admin().post('/api/v1/projects').send({ name: 'Publisher' })
    ).body.id;
    granteeId = (
      await admin().post('/api/v1/projects').send({ name: 'Grantee' })
    ).body.id;
    const otherId = (
      await admin().post('/api/v1/projects').send({ name: 'Other' })
    ).body.id;
    granteeKey = (
      await admin()
        .post('/api/v1/api-keys')
        .send({ name: 'Grantee key', project_id: granteeId })
    ).body.key;
    otherKey = (
      await admin()
        .post('/api/v1/api-keys')
        .send({ name: 'Other key', project_id: otherId })
    ).body.key;

    const provider = await admin().post('/api/v1/ai-providers').send({
      project_id: publisherId,
      name: 'Publisher Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    const tool = await admin()
      .post('/api/v1/tools')
      .send({
        project_id: publisherId,
        name: 'clientTool',
        type: 'client',
        parameters: { type: 'object', properties: {} },
      });
    const agent = await admin()
      .post('/api/v1/agents')
      .send({
        project_id: publisherId,
        name: 'Shared Client Tool Agent',
        ai_provider_id: provider.body.id,
        max_steps: 4,
        tool_bindings: [{ tool_id: tool.body.id }],
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;

    const share = await admin()
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: `srn:${publisherId}:agent:${agentId}`,
        actions: ['agents:CreateAgentGeneration'],
        grantee: granteeId,
      });
    expect(share.status).toBe(201);
    const accepted = await grantee().post(
      `/api/v1/shares/${share.body.id}/accept`
    );
    expect(accepted.status).toBe(200);
  });

  afterAll(async () => {
    await stub.close();
  });

  test('the grantee answers the paused turn', async () => {
    const generationId = await pause({ toolCallId: 'tc_mem', restart: false });

    const res = await submit({
      key: granteeKey,
      generationId,
      toolCallId: 'tc_mem',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.output.content).toBe('resumed answer');
  });

  test('after a restart the turn resumes in the grantee project', async () => {
    const generationId = await pause({ toolCallId: 'tc_db', restart: true });

    const res = await submit({
      key: granteeKey,
      generationId,
      toolCallId: 'tc_db',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.output.content).toBe('resumed answer');
    expect(await meteredProjects(generationId)).toEqual([granteeId, granteeId]);
  });

  /** A grantee session turn paused on the client tool, forgotten in memory. */
  const pauseSession = async (toolCallId: string) => {
    const session = await grantee()
      .post('/api/v1/sessions')
      .send({ agent_id: agentId });
    expect(session.status).toBe(201);
    await grantee()
      .post(`/api/v1/sessions/${session.body.id}/messages`)
      .send({ message: 'hi' });
    stub.reply(
      toolCallCompletion([{ id: toolCallId, name: 'clientTool' }]),
      textCompletion('resumed answer')
    );
    const paused = await grantee().post(
      `/api/v1/sessions/${session.body.id}/generate?wait=true`
    );
    expect(paused.body.status).toBe('requires_action');
    pendingGenerations.delete(paused.body.generation_id);
    return {
      sessionId: session.body.id as string,
      generationId: paused.body.generation_id as string,
      traceId: paused.body.trace_id as string,
    };
  };

  const submitSession = (args: {
    sessionId: string;
    generationId: string;
    toolCallId: string;
  }) => {
    return grantee()
      .post(`/api/v1/sessions/${args.sessionId}/tool-outputs`)
      .send({
        generation_id: args.generationId,
        tool_outputs: [{ tool_call_id: args.toolCallId, output: 'ok' }],
      });
  };

  test('a session in the grantee resumes the turn after a restart', async () => {
    const paused = await pauseSession('tc_session');

    const res = await submitSession({ ...paused, toolCallId: 'tc_session' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(await meteredProjects(paused.generationId)).toEqual([
      granteeId,
      granteeId,
    ]);
    const trace = await admin().get(`/api/v1/traces/${paused.traceId}`);
    expect(trace.body).toMatchObject({ project_id: granteeId, step_count: 2 });
  });

  test("the publisher's pause does not hold a resumed session turn", async () => {
    const paused = await pauseSession('tc_publisher_paused');
    await admin()
      .post(`/api/v1/projects/${publisherId}/pause`)
      .send({ reason: 'maintenance' })
      .expect(200);

    try {
      const res = await submitSession({
        ...paused,
        toolCallId: 'tc_publisher_paused',
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
    } finally {
      await admin().post(`/api/v1/projects/${publisherId}/resume`).expect(200);
    }
  });

  test('a project the agent is not shared with cannot answer the turn', async () => {
    const generationId = await pause({ toolCallId: 'tc_other', restart: true });

    const res = await submit({
      key: otherKey,
      generationId,
      toolCallId: 'tc_other',
    });

    expect(res.status).toBe(404);
  });

  test('unauthenticated request returns 401', async () => {
    const res = await testClient
      .post(`/api/v1/agents/${agentId}/generate/gen_any/tool-outputs`)
      .send({ tool_outputs: [{ tool_call_id: 'tc', output: 'ok' }] });

    expect(res.status).toBe(401);
  });
});
