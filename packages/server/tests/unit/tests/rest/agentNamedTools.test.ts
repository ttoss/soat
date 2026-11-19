import { db } from 'src/db';

import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * `tool_choice`, `step_rules[].tool_choice` and `has_tool_call` name a tool by
 * the name the model is offered it under; a `builtin` action is offered as
 * `<tool name>_<action>`, so the bare action name is not one of them.
 */
describe('tools an agent names must be among the tools it offers', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let documentsToolId: string;
  let doneToolId: string;
  let mcpToolId: string;

  const OFFERED = 'documents_list-documents';

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createAgent = (body: Record<string, unknown>) => {
    return asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: `named-${Math.random().toString(36).slice(2, 8)}`,
        tool_bindings: [{ tool_id: documentsToolId }],
        ...body,
      });
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({ routes: {} });

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'namedtoolsadmin', password: 'supersecret' });
    adminToken = await loginAs('namedtoolsadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Named Tools Project' });
    projectId = project.body.id;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Named Tools Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    aiProviderId = provider.body.id;

    const documentsTool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'documents',
        type: 'builtin',
        actions: ['list-documents'],
      });
    expect(documentsTool.status).toBe(201);
    documentsToolId = documentsTool.body.id;

    const doneTool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'done',
        type: 'client',
        description: 'Signals the task is finished.',
        parameters: { type: 'object', properties: {} },
      });
    expect(doneTool.status).toBe(201);
    doneToolId = doneTool.body.id;

    const mcpTool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'remote',
        type: 'mcp',
        mcp: { url: `${stub.baseUrl}/mcp` },
      });
    expect(mcpTool.status).toBe(201);
    mcpToolId = mcpTool.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/agents', () => {
    test.each([
      [
        'tool_choice',
        {
          tool_choice: { type: 'tool', tool_name: 'list-documents' },
          stop_conditions: [{ type: 'has_tool_call', tool_name: OFFERED }],
        },
      ],
      [
        'stop_conditions',
        {
          stop_conditions: [
            { type: 'has_tool_call', tool_name: 'list-documents' },
          ],
        },
      ],
      [
        'step_rules[].tool_choice',
        {
          step_rules: [
            {
              step: 1,
              tool_choice: { type: 'tool', tool_name: 'list-documents' },
            },
          ],
        },
      ],
    ])('refuses %s naming a tool it does not offer', async (field, body) => {
      const res = await createAgent(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AGENT_TOOL_NOT_OFFERED');
      expect(res.body.error.message).toContain(OFFERED);
      expect(res.body.error.meta).toEqual({
        field,
        tool_name: 'list-documents',
        offered_tool_names: [OFFERED],
      });
    });

    test('accepts the names it offers', async () => {
      const res = await createAgent({
        tool_choice: { type: 'tool', tool_name: OFFERED },
        stop_conditions: [{ type: 'has_tool_call', tool_name: OFFERED }],
        step_rules: [
          { step: 1, tool_choice: { type: 'tool', tool_name: OFFERED } },
        ],
      });

      expect(res.status).toBe(201);
    });

    test('refuses a tool narrowed out by active_tool_ids', async () => {
      const res = await createAgent({
        tool_bindings: [{ tool_id: documentsToolId }, { tool_id: doneToolId }],
        active_tool_ids: [documentsToolId],
        stop_conditions: [{ type: 'has_tool_call', tool_name: 'done' }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.meta.offered_tool_names).toEqual([OFFERED]);
    });

    test('an agent offering no tools names none', async () => {
      const res = await createAgent({
        tool_bindings: [],
        stop_conditions: [{ type: 'has_tool_call', tool_name: 'done' }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Tools it offers: none.');
    });

    // An `mcp` binding's names come from its server's listing.
    test('defers to generation start when a binding is listed by its server', async () => {
      const res = await createAgent({
        tool_bindings: [{ tool_id: mcpToolId }],
        stop_conditions: [{ type: 'has_tool_call', tool_name: 'anything' }],
      });

      expect(res.status).toBe(201);
    });
  });

  describe('PATCH /api/v1/agents/:agent_id', () => {
    test('refuses removing the binding a stop condition names', async () => {
      const created = await createAgent({
        tool_bindings: [{ tool_id: documentsToolId }, { tool_id: doneToolId }],
        stop_conditions: [{ type: 'has_tool_call', tool_name: 'done' }],
      });
      expect(created.status).toBe(201);

      const res = await asAdmin()
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ tool_bindings: [{ tool_id: documentsToolId }] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AGENT_TOOL_NOT_OFFERED');
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    // A row stored before the write check reaches generation unchanged.
    test('refuses a stored agent naming a tool it does not offer', async () => {
      const created = await createAgent({
        tool_choice: { type: 'tool', tool_name: OFFERED },
        stop_conditions: [{ type: 'has_tool_call', tool_name: OFFERED }],
      });
      expect(created.status).toBe(201);
      await db.Agent.update(
        {
          toolChoice: { type: 'tool', tool_name: 'list-documents' },
          stopConditions: [
            { type: 'has_tool_call', tool_name: 'list-documents' },
          ],
        },
        { where: { publicId: created.body.id } }
      );
      stub.completions.length = 0;

      const res = await asAdmin()
        .post(`/api/v1/agents/${created.body.id}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'list them' }] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AGENT_TOOL_NOT_OFFERED');
      expect(res.body.error.meta.offered_tool_names).toEqual([OFFERED]);
      expect(stub.completions).toHaveLength(0);
    });
  });
});
