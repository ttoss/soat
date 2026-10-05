import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';

// `runtime.<module>.<metric>.<window>` keys read the usage meter live at
// evaluation time, scoped to the module's entity in the call. The meter is
// written by the calls themselves, so each counter is driven by making the
// calls it counts.

const ceiling = (key: string, limit: number) => {
  return { class: 'B', guard: { '<': [{ var: key }, limit] } };
};

describe('guardrail runtime metrics', () => {
  let turn: AgentToolTurn;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'runtimemetric' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  const call = (toolId: string) => {
    return turn
      .api()
      .post(`/api/v1/tools/${toolId}/call`)
      .send({ input: { amount: 1 } });
  };

  const expectTripwire = (res: {
    status: number;
    body: { error: { code: string; meta: { outcome: string } } };
  }) => {
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TOOL_DISPATCH_FAILED');
    expect(res.body.error.meta.outcome).toBe('tripwire');
  };

  describe('POST /api/v1/tools/{tool_id}/call', () => {
    test("runtime.tools.tool_calls admits N calls and trips the next, not counting another tool's", async () => {
      const other = await turn.createTool();
      const capped = await turn.createTool({
        guardrail_ids: [
          await turn.createGuardrail(
            ceiling('runtime.tools.tool_calls.24h', 2)
          ),
        ],
      });
      for (let i = 0; i < 3; i += 1) {
        expect((await call(other.id)).status).toBe(200);
      }

      expect((await call(capped.id)).status).toBe(200);
      expect((await call(capped.id)).status).toBe(200);
      expectTripwire(await call(capped.id));
      expect(turn.target.bodiesAt(`/${capped.name}`)).toHaveLength(2);
    });

    test('runtime.tools.errors counts the calls the target failed', async () => {
      const tool = await turn.createTool({
        guardrail_ids: [
          await turn.createGuardrail(ceiling('runtime.tools.errors.1h', 1)),
        ],
      });
      turn.target.reply(`/${tool.name}`, { status: 500 });

      expect((await call(tool.id)).status).toBe(502);
      expectTripwire(await call(tool.id));
      expect(turn.target.bodiesAt(`/${tool.name}`)).toHaveLength(1);
    });

    test("runtime.tools.tool_calls.total counts the tool's whole history", async () => {
      const tool = await turn.createTool({
        guardrail_ids: [
          await turn.createGuardrail(
            ceiling('runtime.tools.tool_calls.total', 1)
          ),
        ],
      });

      expect((await call(tool.id)).status).toBe(200);
      expectTripwire(await call(tool.id));
    });

    test('runtime.guardrails.tool_calls caps the tools one guardrail gates as a set', async () => {
      const guardrailId = await turn.createGuardrail(
        ceiling('runtime.guardrails.tool_calls.24h', 2)
      );
      const first = await turn.createTool({ guardrail_ids: [guardrailId] });
      const second = await turn.createTool({ guardrail_ids: [guardrailId] });

      expect((await call(first.id)).status).toBe(200);
      expect((await call(second.id)).status).toBe(200);
      expectTripwire(await call(first.id));
    });

    test('runtime.tools.name selects a per-tool cap inside one guardrail', async () => {
      const lookupName = turn.unique('lookup');
      const guardrailId = await turn.createGuardrail({
        class: 'B',
        guard: {
          if: [
            { '==': [{ var: 'runtime.tools.name' }, lookupName] },
            { '<': [{ var: 'runtime.tools.tool_calls.24h' }, 1] },
            true,
          ],
        },
      });
      const lookup = await turn.createTool({
        name: lookupName,
        guardrail_ids: [guardrailId],
      });
      const refund = await turn.createTool({ guardrail_ids: [guardrailId] });

      expect((await call(lookup.id)).status).toBe(200);
      expectTripwire(await call(lookup.id));
      expect((await call(refund.id)).status).toBe(200);
      expect((await call(refund.id)).status).toBe(200);
    });

    test('runtime.orchestrations.* is unresolved outside a run and fails closed', async () => {
      const tool = await turn.createTool({
        guardrail_ids: [
          await turn.createGuardrail(
            ceiling('runtime.orchestrations.tool_calls.total', 1000)
          ),
        ],
      });

      expectTripwire(await call(tool.id));
      expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([]);
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test("runtime.agents.tool_calls counts the calling agent's calls, not another agent's", async () => {
      const tool = await turn.createTool({
        guardrail_ids: [
          await turn.createGuardrail(
            ceiling('runtime.agents.tool_calls.24h', 2)
          ),
        ],
      });
      const busy = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });
      const fresh = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });
      const refund = [{ name: tool.name, args: { amount: 1 } }];

      for (let i = 0; i < 2; i += 1) {
        const { results } = await turn.generate({
          agentId: busy,
          calls: refund,
        });
        expect(results).toEqual([{ ok: true }]);
      }
      const other = await turn.generate({ agentId: fresh, calls: refund });
      const tripped = await turn.generate({ agentId: busy, calls: refund });

      expect(other.results).toEqual([{ ok: true }]);
      expect(tripped.results).toEqual([
        expect.objectContaining({ status: 'tripwire' }),
      ]);
    });

    test('an agent-turn execution is metered against its generation and agent', async () => {
      const tool = await turn.gatedTool({
        documents: [ceiling('runtime.projects.tool_calls.24h', 1000)],
      });

      const { id } = await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: { amount: 1 } }],
      });

      const res = await turn
        .api()
        .get('/api/v1/usage/events')
        .query({ meter_type: 'tool_execution', tool_id: tool.id });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        expect.objectContaining({
          tool_id: tool.id,
          agent_id: tool.agentId,
          generation_id: id,
          outcome: 'ok',
        }),
      ]);
    });
  });

  describe('POST /api/v1/guardrails/{guardrail_id}/evaluate', () => {
    test('a project window whose AI spend went unpriced publishes its cost as null', async () => {
      const agentId = await turn.createAgent({});
      await turn.generate({ agentId, calls: [] });
      const guardrailId = await turn.createGuardrail(
        ceiling('runtime.projects.cost_usd.24h', 100)
      );

      const res = await turn
        .api()
        .post(`/api/v1/guardrails/${guardrailId}/evaluate`)
        .send({ args: { amount: 1 } });

      expect(res.status).toBe(200);
      expect(
        res.body.context_snapshot['runtime.projects.cost_usd.24h']
      ).toBeNull();
      expect(res.body.guard_result).toBe(false);
      expect(res.body.decision).toBe('tripwire');
    });
  });

  describe('POST /api/v1/orchestration-runs', () => {
    /**
     * A run whose agent node spends one metered provider call, then a tool
     * node gated by `document`. With `spend: false` the tool node runs alone.
     */
    const runCeiling = async (args: { document: object; spend?: boolean }) => {
      const agentId = await turn.createAgent({});
      const tool = await turn.createTool({
        guardrail_ids: [await turn.createGuardrail(args.document)],
      });
      const act = {
        id: 'act',
        type: 'tool',
        tool_id: tool.id,
        input_mapping: { amount: 1 },
      };
      const spend = args.spend ?? true;
      const created = await turn
        .api()
        .post('/api/v1/orchestrations')
        .send({
          project_id: turn.projectId,
          name: turn.unique('ceiling-run'),
          nodes: spend
            ? [
                {
                  id: 'ask',
                  type: 'agent',
                  agent_id: agentId,
                  input_mapping: { prompt: { var: 'question' } },
                },
                act,
              ]
            : [act],
          edges: spend ? [{ from: 'ask', to: 'act' }] : [],
        });
      expect(created.status).toBe(201);

      const run = await turn
        .api()
        .post('/api/v1/orchestration-runs')
        .send({
          orchestration_id: created.body.id,
          wait: true,
          input: { question: 'hello' },
        });
      expect(run.status).toBe(201);
      expect(run.body.status).toBe('succeeded');
      return { calls: turn.target.bodiesAt(`/${tool.name}`) };
    };

    test('a run under its token ceiling executes the tool node', async () => {
      const { calls } = await runCeiling({
        document: ceiling('runtime.orchestrations.tokens.total', 1000),
      });

      expect(calls).toHaveLength(1);
    });

    test('a run over its token ceiling blocks the tool node', async () => {
      const { calls } = await runCeiling({
        document: ceiling('runtime.orchestrations.tokens.total', 10),
      });

      expect(calls).toEqual([]);
    });

    test("a run's token total counts only that run, not the project", async () => {
      await runCeiling({
        document: ceiling('runtime.orchestrations.tokens.total', 1000),
      });

      const { calls } = await runCeiling({
        document: ceiling('runtime.orchestrations.tokens.total', 1),
        spend: false,
      });

      expect(calls).toHaveLength(1);
    });

    test('a run that metered AI spend and priced none of it fails a cost ceiling closed', async () => {
      const { calls } = await runCeiling({
        document: ceiling('runtime.orchestrations.cost_usd.total', 100),
      });

      expect(calls).toEqual([]);
    });
  });
});
