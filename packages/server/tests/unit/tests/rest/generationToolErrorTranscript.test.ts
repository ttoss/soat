import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

/**
 * A failed tool call is stored as the error the tool threw, and an `Error`
 * stringifies to `{}` — so the steps object keeps its message, name and every
 * field the tool attached, or the transcript of a failed call says nothing.
 */
describe('GET /api/v1/generations/:generation_id/transcript — failed tool call', () => {
  let stub: ChatCompletionsStub;
  let userToken: string;
  let agentId: string;
  let contextAgentId: string;

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/orders': () => {
          return { status: 401, body: { reason: 'Denied' } };
        },
      },
    });

    const setup = await setupProjectWithUsers({
      prefix: 'toolerrtranscript',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateAgentGeneration',
        'generations:GetGeneration',
        'traces:GetTrace',
        'tools:CreateTool',
      ],
    });
    userToken = setup.userToken;

    const providerRes = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: setup.projectId,
        name: 'Tool Error Provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stub.baseUrl,
      });

    const toolRes = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: setup.projectId,
        name: 'update_order',
        type: 'http',
        description: 'Updates an order.',
        parameters: { type: 'object', properties: {} },
        execute: { url: `${stub.baseUrl}/orders/1`, method: 'PATCH' },
      });
    expect(toolRes.status).toBe(201);

    const agentRes = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: setup.projectId,
        ai_provider_id: providerRes.body.id,
        name: 'Tool Error Agent',
        tool_bindings: [{ tool_id: toolRes.body.id }],
        max_steps: 3,
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;

    // The URL names a context key the turn never supplies, so the call fails
    // inside the server with a plain `Error` subclass, not an HTTP response.
    const contextToolRes = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: setup.projectId,
        name: 'ping_warehouse',
        type: 'http',
        description: 'Pings the warehouse.',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: `${stub.baseUrl}/orders/ping`,
          method: 'POST',
          headers: { Authorization: 'Bearer {{context:warehouseToken}}' },
        },
      });
    expect(contextToolRes.status).toBe(201);

    const contextAgentRes = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: setup.projectId,
        ai_provider_id: providerRes.body.id,
        name: 'Context Tool Agent',
        tool_bindings: [{ tool_id: contextToolRes.body.id }],
        max_steps: 3,
      });
    expect(contextAgentRes.status).toBe(201);
    contextAgentId = contextAgentRes.body.id;
  });

  const failedToolResult = async (args: {
    agentId: string;
    toolName: string;
  }) => {
    stub.reply(
      toolCallCompletion([{ id: 'call_failed', name: args.toolName }]),
      textCompletion('The call failed.')
    );
    const generated = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'Go ahead' }] });
    expect(generated.status).toBe(200);
    expect(generated.body.status).toBe('completed');

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/generations/${generated.body.id}/transcript`
    );
    expect(res.status).toBe(200);
    const [failed] = res.body.steps[0].tool_results;
    expect(failed.result).toBeNull();
    return failed.error;
  };

  afterAll(async () => {
    await stub.close();
  });

  test('keeps the HTTP failure the tool threw, field by field', async () => {
    const error = await failedToolResult({ agentId, toolName: 'update_order' });

    expect(error).toMatchObject({
      name: 'HttpToolError',
      status: 401,
      url: `${stub.baseUrl}/orders/1`,
      method: 'PATCH',
    });
    expect(error.message).toContain('401');
    expect(error.body).toContain('Denied');
  });

  test('keeps the message, name and fields of a server-side error', async () => {
    const error = await failedToolResult({
      agentId: contextAgentId,
      toolName: 'ping_warehouse',
    });

    expect(error).toMatchObject({
      name: 'DomainError',
      code: 'MISSING_TOOL_CONTEXT_KEY',
      meta: { header: 'Authorization', key: 'warehouseToken' },
    });
    expect(error.message).toContain('{{context:warehouseToken}}');
  });
});
