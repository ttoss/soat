import {
  type ChatCompletionsStub,
  offeredToolNames,
  startChatCompletionsStub,
  textCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * `output_schema` binds the answer, not just the `response_format` hint the
 * provider sees: a model can return every required key with the right type and
 * filler for values, and only the full schema — `minLength` here — rejects it.
 */
describe('POST /api/v1/agents/:agent_id/generate with output_schema', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let agentId: string;
  let toolAgentId: string;

  const REVIEW_SCHEMA = {
    type: 'object',
    required: ['text', 'approved'],
    properties: {
      text: { type: 'string', minLength: 200 },
      approved: { type: 'boolean' },
    },
  };

  const generate = (id: string) => {
    stub.completions.length = 0;
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${id}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'review this' }] });
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'outschemaadmin', password: 'supersecret' });
    adminToken = await loginAs('outschemaadmin', 'supersecret');
    const asAdmin = () => {
      return authenticatedTestClient(adminToken);
    };

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Output Schema Project' });
    const projectId = project.body.id;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Output Schema Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });

    const agent = await asAdmin().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: provider.body.id,
      name: 'Output Schema Agent',
      output_schema: REVIEW_SCHEMA,
    });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;

    const tool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'lookup',
        type: 'client',
        description: 'A tool the agent is meant to call.',
        parameters: { type: 'object', properties: {} },
      });
    expect(tool.status).toBe(201);

    const toolAgent = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Output Schema Tool Agent',
        output_schema: REVIEW_SCHEMA,
        tool_bindings: [{ tool_id: tool.body.id }],
      });
    expect(toolAgent.status).toBe(201);
    toolAgentId = toolAgent.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  test('a degenerate object whose keys and types are right fails the generation', async () => {
    stub.reply(
      textCompletion(
        JSON.stringify({ text: 'get-fundamental-truth', approved: true })
      )
    );

    const res = await generate(agentId);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('OUTPUT_SCHEMA_VALIDATION_FAILED');
    expect(res.body.error.message).toContain('text');
  });

  test('an object satisfying the schema completes and is returned', async () => {
    const object = { text: 'a'.repeat(200), approved: true };
    stub.reply(textCompletion(JSON.stringify(object)));

    const res = await generate(agentId);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.output.object).toEqual(object);
  });

  // The no-tools retry exists for a provider that rejects the tool
  // definitions. A schema violation is the model's answer, so retrying without
  // tools would spend a second call and could complete an answer the agent was
  // required to reach through a tool.
  test('a schema violation is not retried without tools', async () => {
    stub.reply(
      textCompletion(JSON.stringify({ text: 'too short', approved: true }))
    );

    const res = await generate(toolAgentId);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('OUTPUT_SCHEMA_VALIDATION_FAILED');
    expect(stub.completions).toHaveLength(1);
    expect(offeredToolNames(stub.completions[0])).toEqual(['lookup']);
  });
});
