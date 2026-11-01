import {
  type ChatCompletionsStub,
  type RecordedRequest,
  startChatCompletionsStub,
  textCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A model reads a schema's properties in the order they are written, so an
 * `output_schema` or a tool's `parameters` keeps its author's key order from
 * the write to the read and to the provider. Each order below is the reverse of
 * the one a key-sorting store would give.
 */
describe('model-facing schemas keep their key order', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let agentId: string;
  let toolId: string;

  const OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
      reasoning: { type: 'string' },
      answer: { type: 'string' },
    },
    required: ['reasoning', 'answer'],
  };

  const PARAMETERS = {
    type: 'object',
    properties: {
      customer_name: { type: 'string' },
      city: { type: 'string' },
    },
  };

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const propertyKeys = (schema: unknown): string[] => {
    if (typeof schema !== 'object' || schema === null) return [];
    const properties = 'properties' in schema ? schema.properties : undefined;
    if (typeof properties !== 'object' || properties === null) return [];
    return Object.keys(properties);
  };

  const offeredParameters = (request: RecordedRequest): unknown => {
    const tools = request.body.tools;
    if (!Array.isArray(tools)) return undefined;
    const [entry] = tools;
    if (typeof entry !== 'object' || entry === null) return undefined;
    const fn = 'function' in entry ? entry.function : undefined;
    if (typeof fn !== 'object' || fn === null) return undefined;
    return 'parameters' in fn ? fn.parameters : undefined;
  };

  const responseSchema = (request: RecordedRequest): unknown => {
    const format = request.body.response_format;
    if (typeof format !== 'object' || format === null) return undefined;
    const spec = 'json_schema' in format ? format.json_schema : undefined;
    if (typeof spec !== 'object' || spec === null) return undefined;
    return 'schema' in spec ? spec.schema : undefined;
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'keyorderadmin', password: 'supersecret' });
    adminToken = await loginAs('keyorderadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Key Order Project' });

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: project.body.id,
      name: 'Key Order Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });

    const tool = await asAdmin().post('/api/v1/tools').send({
      project_id: project.body.id,
      name: 'lookup',
      type: 'client',
      description: 'Looks a customer up.',
      parameters: PARAMETERS,
    });
    expect(tool.status).toBe(201);
    toolId = tool.body.id;

    const agent = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: project.body.id,
        ai_provider_id: provider.body.id,
        name: 'Key Order Agent',
        output_schema: OUTPUT_SCHEMA,
        tool_bindings: [{ tool_id: toolId }],
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  test('an agent output_schema reads back in the order written', async () => {
    const res = await asAdmin().get(`/api/v1/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.output_schema)).toEqual([
      'type',
      'properties',
      'required',
    ]);
    expect(propertyKeys(res.body.output_schema)).toEqual([
      'reasoning',
      'answer',
    ]);
  });

  test('a tool parameters schema reads back in the order written', async () => {
    const res = await asAdmin().get(`/api/v1/tools/${toolId}`);

    expect(res.status).toBe(200);
    expect(propertyKeys(res.body.parameters)).toEqual([
      'customer_name',
      'city',
    ]);
  });

  test('both reach the provider in the order written', async () => {
    stub.completions.length = 0;
    stub.reply(
      textCompletion(JSON.stringify({ reasoning: 'because', answer: 'yes' }))
    );

    const res = await asAdmin()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'decide' }] });

    expect(res.status).toBe(200);
    const [request] = stub.completions;
    expect(propertyKeys(responseSchema(request))).toEqual([
      'reasoning',
      'answer',
    ]);
    expect(propertyKeys(offeredParameters(request))).toEqual([
      'customer_name',
      'city',
    ]);
  });
});
