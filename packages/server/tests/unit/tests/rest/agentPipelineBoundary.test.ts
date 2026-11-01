import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';

// A pipeline bound to an agent runs its builtin steps as that agent's calls,
// so the agent's `boundary_policy` holds for every step, however nested.

const DENY_GET_FILE = {
  statement: [{ effect: 'Deny', action: ['files:GetFile'] }],
};

const ALLOW_GET_FILE = {
  statement: [{ effect: 'Allow', action: ['files:GetFile'], resource: ['*'] }],
};

const REFUSAL = { error: 'Forbidden: boundary policy denies files:GetFile' };

describe("an agent's boundary_policy bounds the builtin steps of its pipeline tools", () => {
  let turn: AgentToolTurn;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'pipebound' });
  });

  afterAll(async () => {
    await turn.close();
  });

  const listFilesTool = () => {
    return turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['list-files'],
    });
  };

  const pipelineTool = (steps: Array<Record<string, unknown>>) => {
    return turn.createTool({
      type: 'pipeline',
      execute: undefined,
      parameters: { type: 'object', properties: {} },
      pipeline: { steps },
    });
  };

  const callThroughAgent = async (args: {
    tool: { id: string; name: string };
    boundaryPolicy?: object;
  }) => {
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: args.tool.id }],
      ...(args.boundaryPolicy ? { boundary_policy: args.boundaryPolicy } : {}),
    });
    const { results } = await turn.generate({
      agentId,
      calls: [{ name: args.tool.name, args: {} }],
    });
    return results[0];
  };

  test('a tool_id step is refused an action the boundary denies', async () => {
    const builtin = await listFilesTool();
    const pipeline = await pipelineTool([
      { id: 'list', tool_id: builtin.id, action: 'list-files', input: {} },
    ]);

    await expect(
      callThroughAgent({ tool: pipeline, boundaryPolicy: DENY_GET_FILE })
    ).resolves.toEqual(REFUSAL);
  });

  test('an inline builtin step is refused an action the boundary denies', async () => {
    const pipeline = await pipelineTool([
      {
        id: 'list',
        tool: {
          name: turn.unique('inline-builtin'),
          type: 'builtin',
          actions: ['list-files'],
        },
        action: 'list-files',
        input: {},
      },
    ]);

    await expect(
      callThroughAgent({ tool: pipeline, boundaryPolicy: DENY_GET_FILE })
    ).resolves.toEqual(REFUSAL);
  });

  test('a step of a nested pipeline is refused an action the boundary denies', async () => {
    const builtin = await listFilesTool();
    const inner = await pipelineTool([
      { id: 'list', tool_id: builtin.id, action: 'list-files', input: {} },
    ]);
    const outer = await pipelineTool([
      { id: 'inner', tool_id: inner.id, input: {} },
    ]);

    await expect(
      callThroughAgent({ tool: outer, boundaryPolicy: DENY_GET_FILE })
    ).resolves.toEqual(REFUSAL);
  });

  test('a step runs an action the boundary allows', async () => {
    const builtin = await listFilesTool();
    const pipeline = await pipelineTool([
      { id: 'list', tool_id: builtin.id, action: 'list-files', input: {} },
    ]);

    const result = await callThroughAgent({
      tool: pipeline,
      boundaryPolicy: ALLOW_GET_FILE,
    });

    expect(Array.isArray(result.data)).toBe(true);
  });

  test('a step runs unbounded for an agent with no boundary', async () => {
    const builtin = await listFilesTool();
    const pipeline = await pipelineTool([
      { id: 'list', tool_id: builtin.id, action: 'list-files', input: {} },
    ]);

    const result = await callThroughAgent({ tool: pipeline });

    expect(Array.isArray(result.data)).toBe(true);
  });
});
