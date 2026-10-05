import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';

// A client tool has no server-side execute, so its guardrails run at the
// `requires_action` handoff: a call the gate releases is handed to the caller,
// and one it holds back gets a synthesized result the turn continues on.

const CLIENT_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' }, amount: { type: 'number' } },
};

describe('POST /api/v1/agents/:agent_id/generate — client tool guardrail gate', () => {
  let turn: AgentToolTurn;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'clientgate' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  const gatedClientTool = async (args: {
    document: object;
    guardrail?: Record<string, unknown>;
  }) => {
    const guardrailId = await turn.createGuardrail(
      args.document,
      args.guardrail
    );
    const tool = await turn.createTool({
      type: 'client',
      execute: undefined,
      parameters: CLIENT_SCHEMA,
      guardrail_ids: [guardrailId],
    });
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: tool.id }],
    });
    return { ...tool, agentId, guardrailId };
  };

  test('class A releases the call to the client without its justification', async () => {
    const tool = await gatedClientTool({ document: { class: 'A' } });

    const body = await turn.startTurn({
      agentId: tool.agentId,
      calls: [
        { name: tool.name, args: { path: '/a', approval_reasoning: 'x' } },
      ],
    });

    expect(body.status).toBe('requires_action');
    expect(body.required_action?.tool_calls).toEqual([
      expect.objectContaining({ tool_name: tool.name, args: { path: '/a' } }),
    ]);
  });

  test('class D blocks the handoff and the turn continues on the refusal', async () => {
    const tool = await gatedClientTool({ document: { class: 'D' } });

    const { results } = await turn.generate({
      agentId: tool.agentId,
      calls: [{ name: tool.name, args: { path: '/a' } }],
    });

    expect(results).toEqual([expect.objectContaining({ status: 'blocked' })]);
  });

  test('class C files an approval with the justification split off', async () => {
    const tool = await gatedClientTool({ document: { class: 'C' } });

    const { results } = await turn.generate({
      agentId: tool.agentId,
      calls: [
        {
          name: tool.name,
          args: { path: '/secret', approval_reasoning: 'needs sign-off' },
        },
      ],
    });

    expect(results[0]).toMatchObject({
      status: 'pending_approval',
      approval_id: expect.stringMatching(/^apr_/),
    });
    const approval = await turn
      .api()
      .get(`/api/v1/approvals/${results[0].approval_id}`);
    expect(approval.status).toBe(200);
    expect(approval.body).toMatchObject({
      origin: 'tool_call',
      status: 'pending',
      reasoning: 'needs sign-off',
      proposed_action: {
        tool_id: tool.id,
        action: tool.name,
        arguments: { path: '/secret' },
      },
    });
  });

  test('a passing class-B guard releases the call; a failing one trips', async () => {
    const tool = await gatedClientTool({
      document: { class: 'B', guard: { '<': [{ var: 'args.amount' }, 100] } },
    });

    const passed = await turn.startTurn({
      agentId: tool.agentId,
      calls: [{ name: tool.name, args: { amount: 5 } }],
    });
    const tripped = await turn.generate({
      agentId: tool.agentId,
      calls: [{ name: tool.name, args: { amount: 999 } }],
    });

    expect(passed.status).toBe('requires_action');
    expect(tripped.results).toEqual([
      expect.objectContaining({ status: 'tripwire' }),
    ]);
  });

  test('a mixed batch hands off the released call and answers the held one', async () => {
    const tool = await gatedClientTool({
      document: {
        class: { if: [{ '<': [{ var: 'args.amount' }, 100] }, 'A', 'D'] },
      },
    });

    const paused = await turn.startTurn({
      agentId: tool.agentId,
      calls: [
        { name: tool.name, args: { amount: 1 } },
        { name: tool.name, args: { amount: 500 } },
      ],
    });

    expect(paused.status).toBe('requires_action');
    const released = paused.required_action?.tool_calls ?? [];
    expect(released).toEqual([
      expect.objectContaining({ args: { amount: 1 } }),
    ]);

    const resumed = await turn
      .api()
      .post(`/api/v1/agents/${tool.agentId}/generate/${paused.id}/tool-outputs`)
      .send({
        tool_outputs: [{ tool_call_id: released[0].id, output: 'done' }],
      });
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('completed');
    const results = JSON.parse(resumed.body.output.content);
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        'done',
        expect.objectContaining({ status: 'blocked' }),
      ])
    );
  });

  test('the context tool is asked about the proposed client call', async () => {
    const contextTool = await turn.createTool({ parameters: undefined });
    const tool = await gatedClientTool({
      document: { class: 'A' },
      guardrail: { context_tool_id: contextTool.id, context_mode: 'merge' },
    });

    const body = await turn.startTurn({
      agentId: tool.agentId,
      calls: [
        {
          name: tool.name,
          args: { path: '/etc/hosts', approval_reasoning: 'x' },
        },
      ],
    });

    expect(body.status).toBe('requires_action');
    expect(turn.target.bodiesAt(`/${contextTool.name}`)).toEqual([
      {
        call: {
          action: tool.name,
          tool: { id: tool.id, name: tool.name },
          args: { path: '/etc/hosts' },
        },
      },
    ]);
  });
});
