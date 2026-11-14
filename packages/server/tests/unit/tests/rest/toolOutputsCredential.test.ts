import { pendingGenerations } from 'src/lib/agentGenerationHelpers';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  offeredToolNames,
  type RecordedRequest,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

/** The `role: "tool"` contents a recorded completion request carries. */
const toolResultTexts = (request: RecordedRequest): string[] => {
  const messages = request.body.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) => {
    if (typeof message !== 'object' || message === null) return [];
    if (!('role' in message) || message.role !== 'tool') return [];
    return 'content' in message && typeof message.content === 'string'
      ? [message.content]
      : [];
  });
};

/**
 * A resume only narrows: the continuation of a paused generation runs under
 * the authority it stores held to the submitter's, whether the pause is still
 * in memory or rebuilt from the database. Neither side lends the other what
 * it lacks, and resuming needs `generations:ResumeGeneration` on the turn.
 */
describe('POST /api/v1/agents/:agent_id/generate/:generation_id/tool-outputs credential', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let agentId: string;
  let listToolsName: string;
  let noResumeToken: string;
  let resumerAgentId: string;
  let resumerToolName: string;
  let resumeToolId: string;
  let resumePolicyId: string;
  let projectId: string;

  beforeAll(async () => {
    stub = await startChatCompletionsStub();

    // The user may start and answer a generation but not list tools, which
    // only the admin may do.
    const setup = await setupProjectWithUsers({
      prefix: 'tooloutcred',
      policyActions: [
        'agents:GetAgent',
        'agents:CreateAgentGeneration',
        'generations:ResumeGeneration',
        'tools:CallTool',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    userId = setup.userId;
    noResumeToken = await createScopedPrincipal({
      adminToken,
      projectId: setup.projectId,
      username: 'tooloutcrednoresume',
      actions: ['agents:CreateAgentGeneration', 'tools:CallTool'],
    });

    const asAdmin = authenticatedTestClient(adminToken);
    const provider = await asAdmin.post('/api/v1/ai-providers').send({
      project_id: setup.projectId,
      name: 'Credential Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    expect(provider.status).toBe(201);

    const clientTool = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: setup.projectId,
        name: 'clientTool',
        type: 'client',
        parameters: { type: 'object', properties: {} },
      });
    expect(clientTool.status).toBe(201);

    const listTools = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: setup.projectId,
        name: 'credListTools',
        type: 'builtin',
        actions: ['list-tools'],
      });
    expect(listTools.status).toBe(201);

    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: setup.projectId,
        ai_provider_id: provider.body.id,
        name: 'Credential Agent',
        max_steps: 4,
        tool_bindings: [
          { tool_id: clientTool.body.id },
          { tool_id: listTools.body.id },
        ],
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;

    // What a `run_as: agent` agent and a trigger hold: answering another
    // turn's client tool, but not listing tools.
    const resumePolicy = await asAdmin.post('/api/v1/policies').send({
      document: {
        statement: [
          {
            effect: 'Allow',
            action: [
              'agents:CreateAgentGeneration',
              'generations:ResumeGeneration',
              'tools:CallTool',
            ],
          },
        ],
      },
    });
    expect(resumePolicy.status).toBe(201);
    resumerToolName = 'credResume';
    const resumeTool = await asAdmin.post('/api/v1/tools').send({
      project_id: setup.projectId,
      name: resumerToolName,
      type: 'builtin',
      actions: ['submit-agent-tool-outputs'],
    });
    expect(resumeTool.status).toBe(201);
    resumeToolId = resumeTool.body.id;
    resumePolicyId = resumePolicy.body.id;
    projectId = setup.projectId;
    const resumer = await asAdmin.post('/api/v1/agents').send({
      project_id: setup.projectId,
      ai_provider_id: provider.body.id,
      name: 'Resumer Agent',
      max_steps: 4,
      run_as: 'agent',
      policy_ids: [resumePolicy.body.id],
      tool_bindings: [{ tool_id: resumeTool.body.id }],
    });
    expect(resumer.status).toBe(201);
    resumerAgentId = resumer.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  /** `token` starts a turn that pauses on the client tool. */
  const pauseAs = async (token: string): Promise<string> => {
    stub.reply(toolCallCompletion([{ id: 'tc_client', name: 'clientTool' }]));
    stub.completions.length = 0;
    const paused = await authenticatedTestClient(token)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('requires_action');
    listToolsName ??= offeredToolNames(stub.completions[0]).find((name) => {
      return name !== 'clientTool';
    }) as string;
    return paused.body.id;
  };

  const submit = (args: { token: string; generationId: string }) => {
    return authenticatedTestClient(args.token)
      .post(
        `/api/v1/agents/${agentId}/generate/${args.generationId}/tool-outputs`
      )
      .send({ tool_outputs: [{ tool_call_id: 'tc_client', output: 'ok' }] });
  };

  /** `token` answers it, and the continuation calls the list-tools action. */
  const resumeAs = async (args: { token: string; generationId: string }) => {
    stub.reply(
      toolCallCompletion([
        { id: 'tc_list', name: listToolsName, args: { action: 'list-tools' } },
      ]),
      textCompletion('done')
    );
    stub.completions.length = 0;
    const res = await submit(args);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    const [, afterToolCall] = stub.completions;
    return toolResultTexts(afterToolCall).join('\n');
  };

  const userDenied = () => {
    return `user ${userId}'s policies deny tools:ListTools`;
  };

  const getGeneration = async (generationId: string) => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/generations/${generationId}`
    );
    expect(res.status).toBe(200);
    return res.body;
  };

  test('a pause still in memory is held to a narrower submitter', async () => {
    const generationId = await pauseAs(adminToken);
    expect(pendingGenerations.has(generationId)).toBe(true);

    const toolResult = await resumeAs({ token: userToken, generationId });

    expect(toolResult).not.toContain('credListTools');
    expect(toolResult).toContain(userDenied());
  });

  test('a pause rebuilt from the database is held to a narrower submitter', async () => {
    const generationId = await pauseAs(adminToken);
    pendingGenerations.delete(generationId);

    const toolResult = await resumeAs({ token: userToken, generationId });

    expect(toolResult).not.toContain('credListTools');
    expect(toolResult).toContain(userDenied());
  });

  test('a wider submitter lends the turn nothing its starter lacks', async () => {
    const generationId = await pauseAs(userToken);

    const toolResult = await resumeAs({ token: adminToken, generationId });

    expect(toolResult).not.toContain('credListTools');
    expect(toolResult).toContain(userDenied());
  });

  test("a run_as: agent resumer holds the turn to the agent's grant", async () => {
    const generationId = await pauseAs(adminToken);
    // The resumer's turn answers the paused one, whose continuation lists
    // tools before both finish.
    stub.reply(
      toolCallCompletion([
        {
          id: 'tc_resume',
          name: `${resumerToolName}_submit-agent-tool-outputs`,
          args: {
            agent_id: agentId,
            generation_id: generationId,
            tool_outputs: [{ tool_call_id: 'tc_client', output: 'ok' }],
          },
        },
      ]),
      toolCallCompletion([
        { id: 'tc_list', name: listToolsName, args: { action: 'list-tools' } },
      ]),
      textCompletion('done'),
      textCompletion('resumed')
    );
    stub.completions.length = 0;

    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${resumerAgentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'resume it' }] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect((await getGeneration(generationId)).status).toBe('completed');
    const toolResult = toolResultTexts(stub.completions[2]).join('\n');
    expect(toolResult).not.toContain('credListTools');
    expect(toolResult).toContain(
      `agent ${resumerAgentId}'s policies deny tools:ListTools`
    );
  });

  test("a trigger resumer holds the turn to the trigger's grant", async () => {
    const generationId = await pauseAs(adminToken);
    const trigger = await authenticatedTestClient(adminToken)
      .post('/api/v1/triggers')
      .send({
        project_id: projectId,
        policy_ids: [resumePolicyId],
        name: 'credResumeTrigger',
        type: 'manual',
        target_type: 'tool',
        target_id: resumeToolId,
        action: 'submit-agent-tool-outputs',
        input: {
          agent_id: agentId,
          generation_id: generationId,
          tool_outputs: [{ tool_call_id: 'tc_client', output: 'ok' }],
        },
      });
    expect(trigger.status).toBe(201);
    stub.reply(
      toolCallCompletion([
        { id: 'tc_list', name: listToolsName, args: { action: 'list-tools' } },
      ]),
      textCompletion('done')
    );
    stub.completions.length = 0;

    const fired = await authenticatedTestClient(adminToken)
      .post(`/api/v1/triggers/${trigger.body.id}/fire`)
      .send({});

    expect(fired.status).toBe(200);
    expect((await getGeneration(generationId)).status).toBe('completed');
    const toolResult = toolResultTexts(stub.completions[1]).join('\n');
    expect(toolResult).not.toContain('credListTools');
    expect(toolResult).toContain(
      `trigger ${trigger.body.id}'s policies deny tools:ListTools`
    );
  });

  test('a caller without generations:ResumeGeneration is refused', async () => {
    const generationId = await pauseAs(adminToken);

    const res = await submit({ token: noResumeToken, generationId });

    expect(res.status).toBe(403);
    const generation = await authenticatedTestClient(adminToken).get(
      `/api/v1/generations/${generationId}`
    );
    expect(generation.body.status).toBe('requires_action');
  });

  test('a generation acts as the principal that started it', async () => {
    const generationId = await pauseAs(adminToken);

    const generation = await getGeneration(generationId);

    expect(generation.started_by_principal_type).toBe('user');
    expect(generation.acted_as).toEqual({
      principal_type: generation.started_by_principal_type,
      principal_id: generation.started_by_principal_id,
    });
  });

  test('a resumed generation still acts as its starter', async () => {
    const generationId = await pauseAs(adminToken);
    const startedBy = (await getGeneration(generationId))
      .started_by_principal_id;

    await resumeAs({ token: userToken, generationId });
    const generation = await getGeneration(generationId);

    expect(generation.started_by_principal_id).toBe(startedBy);
    expect(generation.acted_as).toEqual({
      principal_type: 'user',
      principal_id: startedBy,
    });
  });
});
