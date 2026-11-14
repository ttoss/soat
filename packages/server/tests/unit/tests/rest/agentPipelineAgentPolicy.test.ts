import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';

// A pipeline bound to an agent runs its builtin steps as that agent's calls,
// so the agent's `policy_ids` hold for every step, however nested.

const CALL_TOOLS = { effect: 'Allow', action: ['tools:CallTool'] };

const DENY_GET_DOCUMENT = {
  statement: [
    CALL_TOOLS,
    { effect: 'Deny', action: ['documents:GetDocument'] },
  ],
};

const ALLOW_GET_DOCUMENT = {
  statement: [
    CALL_TOOLS,
    { effect: 'Allow', action: ['documents:GetDocument'], resource: ['*'] },
  ],
};

describe("an agent's policy_ids bound the builtin steps of its pipeline tools", () => {
  let turn: AgentToolTurn;

  let documentId: string;

  /** A step input naming the document, a literal under JSON Logic. */
  const readDocument = () => {
    return { document_id: documentId };
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'pipebound' });
    const doc = await turn.api().post('/api/v1/documents').send({
      project_id: turn.projectId,
      content: 'read by a pipeline step',
      path: '/pipebound/doc.txt',
    });
    expect(doc.status).toBe(201);
    documentId = doc.body.id;
  });

  afterAll(async () => {
    await turn.close();
  });

  const getDocumentTool = () => {
    return turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['get-document'],
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
    agentPolicy?: object;
  }) => {
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: args.tool.id }],
      ...(args.agentPolicy
        ? { policy_ids: [await turn.createPolicy(args.agentPolicy)] }
        : {}),
    });
    const { results } = await turn.generate({
      agentId,
      calls: [{ name: args.tool.name, args: {} }],
    });
    return { agentId, result: results[0] };
  };

  const expectRefused = async (tool: { id: string; name: string }) => {
    const { agentId, result } = await callThroughAgent({
      tool,
      agentPolicy: DENY_GET_DOCUMENT,
    });
    expect(JSON.stringify(result)).toContain(
      `Forbidden: agent ${agentId}'s policies deny documents:GetDocument`
    );
  };

  test('a tool_id step is refused an action the boundary denies', async () => {
    const builtin = await getDocumentTool();
    const pipeline = await pipelineTool([
      { id: 'list', tool_id: builtin.id, action: 'get-document', input: readDocument() },
    ]);

    await expectRefused(pipeline);
  });

  test('an inline builtin step is refused an action the boundary denies', async () => {
    const pipeline = await pipelineTool([
      {
        id: 'list',
        tool: {
          name: turn.unique('inline-builtin'),
          type: 'builtin',
          actions: ['get-document'],
        },
        action: 'get-document',
        input: readDocument(),
      },
    ]);

    await expectRefused(pipeline);
  });

  test('a step of a nested pipeline is refused an action the boundary denies', async () => {
    const builtin = await getDocumentTool();
    const inner = await pipelineTool([
      { id: 'list', tool_id: builtin.id, action: 'get-document', input: readDocument() },
    ]);
    const outer = await pipelineTool([
      { id: 'inner', tool_id: inner.id, input: {} },
    ]);

    await expectRefused(outer);
  });

  test('a step runs an action the boundary allows', async () => {
    const builtin = await getDocumentTool();
    const pipeline = await pipelineTool([
      { id: 'list', tool_id: builtin.id, action: 'get-document', input: readDocument() },
    ]);

    const { result } = await callThroughAgent({
      tool: pipeline,
      agentPolicy: ALLOW_GET_DOCUMENT,
    });

    expect(result.id).toBe(documentId);
  });

  test('a step runs unbounded for an agent with no boundary', async () => {
    const builtin = await getDocumentTool();
    const pipeline = await pipelineTool([
      { id: 'list', tool_id: builtin.id, action: 'get-document', input: readDocument() },
    ]);

    const { result } = await callThroughAgent({ tool: pipeline });

    expect(result.id).toBe(documentId);
  });
});
