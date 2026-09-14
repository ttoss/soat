import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * `step_rules` × `prompt_caching`, on the wire.
 *
 * A rule's `active_tool_ids` narrows the tool block the SDK serializes, and the
 * cache breakpoint hangs off the last system message — which sits *after* the
 * tools in the prefix. A step whose active set differs from the previous step's
 * therefore sends a different prefix and re-buys all of it (#1301 item 4).
 *
 * The assertion is on the bytes the provider receives, because that is the only
 * place the two features meet: each reads correct on every SOAT surface, and
 * the interaction is visible on the bill alone.
 */
describe('Step rules narrowing tools under prompt caching', () => {
  let stubServer: Server;
  let requestBodies: Array<Record<string, unknown>>;
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;
  let alphaToolId: string;
  let betaToolId: string;

  const usage = { input_tokens: 4, output_tokens: 2 };

  /**
   * Answers the first call of each turn with a call to `alpha_tool` — a client
   * tool, so the turn pauses and the next step arrives as its own request — and
   * every later call with text, unless the request forces a tool: the AI SDK
   * rejects an answer that ignores a forced `tool_choice`.
   */
  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requestBodies.push(body);
        const forcedTool =
          body.tool_choice?.type === 'tool'
            ? (body.tool_choice.name as string)
            : null;
        const isFirstStep = !JSON.stringify(body.messages ?? []).includes(
          'tool_result'
        );
        const calledTool = isFirstStep ? 'alpha_tool' : forcedTool;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-4-5',
            stop_reason: calledTool ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage,
            content: calledTool
              ? [
                  {
                    type: 'tool_use',
                    id: 'toolu_stub_1',
                    name: calledTool,
                    input: { value: 'first' },
                  },
                ]
              : [{ type: 'text', text: 'done' }],
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const createClientTool = async (name: string): Promise<string> => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name,
        type: 'client',
        description: `The ${name} tool`,
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      });
    return response.body.id;
  };

  /** The tool names in the block the stub received on request `index`. */
  const toolNamesOf = (index: number): string[] => {
    const tools = requestBodies[index]?.tools;
    return Array.isArray(tools)
      ? (tools as Array<{ name: string }>).map((entry) => {
          return entry.name;
        })
      : [];
  };

  /**
   * Everything the provider caches under one breakpoint: the tool block and the
   * system block, in prefix order. Equal across two steps means the second step
   * reads the cache; different means it writes a new entry.
   */
  const cachedPrefixOf = (index: number): string => {
    const body = requestBodies[index] ?? {};
    return JSON.stringify([body.tools, body.system]);
  };

  const runTurnToStepTwo = async (agentId: string): Promise<void> => {
    const started = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'go' }] });

    expect(started.status).toBe(200);
    expect(started.body.status).toBe('requires_action');

    const resumed = await authenticatedTestClient(userToken)
      .post(
        `/api/v1/agents/${agentId}/generate/${started.body.id}/tool-outputs`
      )
      .send({
        tool_outputs: [
          {
            tool_call_id: started.body.required_action.tool_calls[0].id,
            output: 'ok',
          },
        ],
      });

    expect(resumed.status).toBe(200);
  };

  beforeAll(async () => {
    requestBodies = [];
    const stubBaseUrl = await startStubServer();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'steprulecacheadmin', password: 'supersecret' });
    const adminToken = await loginAs('steprulecacheadmin', 'supersecret');

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'steprulecacheuser', password: 'steprulecachepass' });
    userToken = await loginAs('steprulecacheuser', 'steprulecachepass');

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'agents:CreateAgent',
                'agents:CreateAgentGeneration',
                'secrets:CreateSecret',
                'tools:CreateTool',
              ],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Step Rule Caching Project' });
    projectId = projectRes.body.id;

    const secretRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({
        project_id: projectId,
        name: 'Step Rule Caching Key',
        value: 'sk-ant-stub',
      });

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Stub Anthropic',
        provider: 'anthropic',
        default_model: 'claude-haiku-4-5',
        secret_id: secretRes.body.id,
        base_url: stubBaseUrl,
      });
    aiProviderId = aiProviderRes.body.id;

    alphaToolId = await createClientTool('alpha_tool');
    betaToolId = await createClientTool('beta_tool');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        return resolve();
      });
    });
  });

  const createAgent = async (stepRules: object[]) => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProviderId,
        project_id: projectId,
        model: 'claude-haiku-4-5',
        name: `Step Rule Caching Agent ${JSON.stringify(stepRules)}`,
        instructions: 'Be terse.',
        prompt_caching: { enabled: true },
        tool_bindings: [{ tool_id: alphaToolId }, { tool_id: betaToolId }],
        step_rules: stepRules,
        max_steps: 4,
      });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  test('a rule narrowing the active set sends a different cached prefix', async () => {
    requestBodies = [];
    const agentId = await createAgent([
      { step: 2, active_tool_ids: [betaToolId] },
    ]);

    await runTurnToStepTwo(agentId);

    expect(requestBodies).toHaveLength(2);
    expect(toolNamesOf(0)).toEqual(['alpha_tool', 'beta_tool']);
    expect(toolNamesOf(1)).toEqual(['beta_tool']);

    // The breakpoint marks the end of the system block, so the tool block is
    // inside the prefix it covers: a narrowed step re-buys the whole prefix.
    expect(cachedPrefixOf(1)).not.toEqual(cachedPrefixOf(0));
  });

  // Forcing a tool by name narrows the active set to it by default, which would
  // change the tool block for that step alone. On a cached agent that trade is
  // inverted — the block is inside the prefix — so the narrowing is dropped and
  // `tool_choice` carries the rule on its own.
  test('a rule that only sets tool_choice leaves the cached prefix alone', async () => {
    requestBodies = [];
    const agentId = await createAgent([
      { step: 2, tool_choice: { type: 'tool', tool_name: 'beta_tool' } },
    ]);

    await runTurnToStepTwo(agentId);

    expect(requestBodies).toHaveLength(2);
    expect(toolNamesOf(1)).toEqual(['alpha_tool', 'beta_tool']);
    expect(cachedPrefixOf(1)).toEqual(cachedPrefixOf(0));
  });

  test('without a narrowing rule the cached prefix is byte-identical', async () => {
    requestBodies = [];
    const agentId = await createAgent([]);

    await runTurnToStepTwo(agentId);

    expect(requestBodies).toHaveLength(2);
    expect(cachedPrefixOf(1)).toEqual(cachedPrefixOf(0));
    expect(JSON.stringify(requestBodies[1]?.system)).toContain('cache_control');
  });
});
