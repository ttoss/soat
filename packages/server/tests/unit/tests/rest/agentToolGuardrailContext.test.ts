import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { offeredProperties } from '../../fixtures/scriptedModel';

// The `context.*` a gated agent-turn call is evaluated against: the caller's
// `guardrail_context`, combined with the guardrail's context tool per its
// `context_mode`. The context tool runs on the target like any other tool, so
// what it is asked and how it answers are both under the test's control.

const TIER_ROUTES = {
  class: { if: [{ '==': [{ var: 'context.tier' }, 'high'] }, 'C', 'A'] },
};

describe('POST /api/v1/agents/:agent_id/generate — guardrail context', () => {
  let turn: AgentToolTurn;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'agentctx' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  /** A context tool on its own target path, and a refund gated by `document`. */
  const gateWithContextTool = async (args: {
    document: object;
    contextMode?: 'merge' | 'replace';
    tool?: Record<string, unknown>;
  }) => {
    const contextTool = await turn.createTool({ parameters: undefined });
    const guardrailId = await turn.createGuardrail(args.document, {
      context_tool_id: contextTool.id,
      context_mode: args.contextMode ?? 'merge',
    });
    const refund = await turn.createTool({
      guardrail_ids: [guardrailId],
      ...args.tool,
    });
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: refund.id }],
    });
    return { contextPath: `/${contextTool.name}`, refund, agentId };
  };

  test("a class expression reads the caller's guardrail_context", async () => {
    const tool = await turn.gatedTool({ documents: [TIER_ROUTES] });
    const call = { name: tool.name, args: { amount: 1 } };

    const high = await turn.generate({
      agentId: tool.agentId,
      calls: [call],
      body: { guardrail_context: { tier: 'high' } },
    });
    const low = await turn.generate({
      agentId: tool.agentId,
      calls: [call],
      body: { guardrail_context: { tier: 'low' } },
    });

    expect(high.results[0].status).toBe('pending_approval');
    expect(low.results).toEqual([{ ok: true }]);
    // An expression class may resolve to C, so the call can carry a justification.
    expect(
      offeredProperties({ model: turn.model, toolName: tool.name })
    ).toHaveProperty('approval_reasoning');
  });

  test('the context tool is asked about every call, with presets pinned and justification removed', async () => {
    const gate = await gateWithContextTool({
      document: { class: 'A' },
      tool: {
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            currency: { type: 'string' },
          },
        },
        preset_parameters: { currency: 'usd' },
      },
    });
    const call = {
      name: gate.refund.name,
      args: {
        amount: 5,
        approval_reasoning: 'customer asked',
        currency: 'eur',
      },
    };

    await turn.generate({ agentId: gate.agentId, calls: [call] });
    await turn.generate({ agentId: gate.agentId, calls: [call] });

    const asked = {
      call: {
        action: gate.refund.name,
        tool: { id: gate.refund.id, name: gate.refund.name },
        args: { amount: 5, currency: 'usd' },
      },
    };
    expect(turn.target.bodiesAt(gate.contextPath)).toEqual([asked, asked]);
    expect(turn.target.bodiesAt(`/${gate.refund.name}`)).toEqual([
      { amount: 5, currency: 'usd' },
      { amount: 5, currency: 'usd' },
    ]);
  });

  test("the context tool's `call.args` are the guard's `args.*`", async () => {
    const gate = await gateWithContextTool({
      document: {
        class: 'B',
        guard: {
          and: [
            {
              '==': [
                { var: 'context.echoed_args.amount' },
                { var: 'args.amount' },
              ],
            },
            { '!': [{ var: 'context.echoed_args.approval_reasoning' }] },
          ],
        },
      },
    });
    turn.target.reply(gate.contextPath, (body) => {
      const call = body.call as { args: Record<string, unknown> };
      return { body: { echoed_args: call.args } };
    });

    const { results } = await turn.generate({
      agentId: gate.agentId,
      calls: [
        {
          name: gate.refund.name,
          args: { amount: 12, approval_reasoning: 'because' },
        },
      ],
    });

    expect(results).toEqual([{ ok: true }]);
  });

  test('merge keeps the caller keys the context tool does not answer', async () => {
    const gate = await gateWithContextTool({
      document: {
        class: {
          if: [{ '==': [{ var: 'context.caller_ok' }, true] }, 'A', 'C'],
        },
      },
    });
    turn.target.reply(gate.contextPath, { body: { tier: 'high' } });

    const { results } = await turn.generate({
      agentId: gate.agentId,
      calls: [{ name: gate.refund.name, args: { amount: 1 } }],
      body: { guardrail_context: { caller_ok: true } },
    });

    expect(results).toEqual([{ ok: true }]);
  });

  test('replace substitutes the context tool answer for the caller context', async () => {
    const gate = await gateWithContextTool({
      document: {
        class: {
          if: [{ '==': [{ var: 'context.caller_ok' }, true] }, 'A', 'C'],
        },
      },
      contextMode: 'replace',
    });
    turn.target.reply(gate.contextPath, { body: { tier: 'high' } });

    const { results } = await turn.generate({
      agentId: gate.agentId,
      calls: [{ name: gate.refund.name, args: { amount: 1 } }],
      body: { guardrail_context: { caller_ok: true } },
    });

    expect(results[0].status).toBe('pending_approval');
  });

  test('a context tool that ignores its input still resolves `context.*`', async () => {
    const gate = await gateWithContextTool({ document: TIER_ROUTES });
    turn.target.reply(gate.contextPath, { body: { tier: 'high' } });

    const { results } = await turn.generate({
      agentId: gate.agentId,
      calls: [{ name: gate.refund.name, args: { amount: 1 } }],
    });

    expect(results[0].status).toBe('pending_approval');
  });

  test('a failing context tool fails closed to the caller context', async () => {
    const gate = await gateWithContextTool({ document: TIER_ROUTES });
    turn.target.reply(gate.contextPath, {
      status: 500,
      body: { tier: 'high' },
    });

    const { results } = await turn.generate({
      agentId: gate.agentId,
      calls: [{ name: gate.refund.name, args: { amount: 1 } }],
    });

    // No caller context and no tool answer: `context.tier` is null, so class A.
    expect(results).toEqual([{ ok: true }]);
  });

  describe('SOAT_GUARDRAIL_CONTEXT_TIMEOUT_MS', () => {
    afterEach(() => {
      delete process.env.SOAT_GUARDRAIL_CONTEXT_TIMEOUT_MS;
    });

    test('a context tool slower than the timeout fails closed', async () => {
      process.env.SOAT_GUARDRAIL_CONTEXT_TIMEOUT_MS = '50';
      const gate = await gateWithContextTool({ document: TIER_ROUTES });
      turn.target.reply(gate.contextPath, {
        body: { tier: 'high' },
        delayMs: 300,
      });

      const { results } = await turn.generate({
        agentId: gate.agentId,
        calls: [{ name: gate.refund.name, args: { amount: 1 } }],
      });

      expect(results).toEqual([{ ok: true }]);
    });
  });
});
