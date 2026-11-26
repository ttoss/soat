import { db } from 'src/db';
import {
  GENERATION_CONTENT_FIELDS,
  GENERATION_PROGRESS_COLUMNS,
} from 'src/lib/traceContentPolicy';

import {
  type AgentToolTurn,
  AMOUNT_SCHEMA,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { pollUntil } from '../../fixtures/poll';
import { proposeCalls, proposeSteps } from '../../fixtures/scriptedModel';

/**
 * A generation's progress rows, recorded by its one instrumentation point
 * while it runs. Turns run for real against a scripted model; only the model
 * and the tools' HTTP target are fakes.
 */
describe('generation progress rows', () => {
  let turn: AgentToolTurn;

  type Row = {
    type: string;
    stepIndex: number | null;
    toolCallId: string | null;
    status: string | null;
    durationMs: number | null;
    childGenerationId: string | null;
  };

  const rowsOf = async (generationId: string): Promise<Row[]> => {
    const generation = await db.Generation.findOne({
      where: { publicId: generationId },
    });
    const rows = await db.GenerationProgressEvent.findAll({
      where: { generationId: generation?.id as number },
      order: [['seq', 'ASC']],
    });
    return rows.map((row) => {
      return {
        type: row.type,
        stepIndex: row.stepIndex,
        toolCallId: row.toolCallId,
        status: row.status,
        durationMs: row.durationMs,
        childGenerationId: row.childGenerationId,
      };
    });
  };

  const toolCallEnds = async (generationId: string) => {
    return (await rowsOf(generationId)).filter((row) => {
      return row.type === 'generations.tool_call_ended';
    });
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'genprogress' });
  });

  afterAll(async () => {
    await turn.close();
  });

  test('carry skeleton columns only', () => {
    const columns = Object.keys(db.GenerationProgressEvent.getAttributes());
    expect([...columns].sort()).toEqual(
      [...GENERATION_PROGRESS_COLUMNS].sort()
    );
    const content: readonly string[] = GENERATION_CONTENT_FIELDS;
    expect(
      columns.filter((column) => {
        return content.includes(column);
      })
    ).toEqual([]);
  });

  test('a tool turn records its lifecycle, steps and tool call in order', async () => {
    const tool = await turn.createTool();
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: tool.id }],
    });

    const { id } = await turn.generate({
      agentId,
      calls: [{ name: tool.name, args: { amount: 1 } }],
    });

    expect(await rowsOf(id)).toEqual([
      expect.objectContaining({ type: 'generations.started' }),
      expect.objectContaining({
        type: 'generations.step_started',
        stepIndex: 0,
      }),
      expect.objectContaining({
        type: 'generations.tool_call_started',
        stepIndex: 0,
        toolCallId: 'call_0',
        status: null,
      }),
      expect.objectContaining({
        type: 'generations.tool_call_ended',
        stepIndex: 0,
        toolCallId: 'call_0',
        status: 'executed',
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({ type: 'generations.step_ended', stepIndex: 0 }),
      expect.objectContaining({
        type: 'generations.step_started',
        stepIndex: 1,
      }),
      expect.objectContaining({ type: 'generations.step_ended', stepIndex: 1 }),
      expect.objectContaining({
        type: 'generations.completed',
        status: 'completed',
      }),
    ]);
  });

  test('an inline tool call is recorded', async () => {
    const name = turn.unique('inline_refund');
    const agentId = await turn.createAgent({
      tool_bindings: [
        {
          tool: {
            name,
            type: 'http',
            parameters: AMOUNT_SCHEMA,
            execute: { url: `${turn.target.baseUrl}/${name}`, method: 'POST' },
          },
        },
      ],
    });

    const { id } = await turn.generate({
      agentId,
      calls: [{ name, args: { amount: 1 } }],
    });

    expect(await toolCallEnds(id)).toEqual([
      expect.objectContaining({ toolCallId: 'call_0', status: 'executed' }),
    ]);
  });

  test("the knowledge binding's write_memory call is recorded", async () => {
    const store = await turn
      .api()
      .post('/api/v1/memory-stores')
      .send({ project_id: turn.projectId, name: turn.unique('notes') });
    expect(store.status).toBe(201);
    const agentId = await turn.createAgent({
      knowledge_config: { write_memory_store_id: store.body.id },
    });

    const { id } = await turn.generate({
      agentId,
      calls: [
        { name: 'write_memory', args: { content: 'Deploys on Tuesday.' } },
      ],
    });

    expect(await toolCallEnds(id)).toEqual([
      expect.objectContaining({ toolCallId: 'call_0', status: 'executed' }),
    ]);
  });

  test('a call a guardrail stops is told apart from an executed one', async () => {
    const tripped = await turn.gatedTool({
      documents: [
        { class: 'B', guard: { '<': [{ var: 'args.amount' }, 100] } },
      ],
    });
    const routed = await turn.gatedTool({ documents: [{ class: 'C' }] });

    const trip = await turn.generate({
      agentId: tripped.agentId,
      calls: [{ name: tripped.name, args: { amount: 999 } }],
    });
    const approval = await turn.generate({
      agentId: routed.agentId,
      calls: [{ name: routed.name, args: { amount: 1 } }],
    });

    expect(await toolCallEnds(trip.id)).toEqual([
      expect.objectContaining({ status: 'tripwire' }),
    ]);
    expect(await toolCallEnds(approval.id)).toEqual([
      expect.objectContaining({ status: 'pending_approval' }),
    ]);
  });

  test('a generation a tool call starts is pointed at from that call', async () => {
    const childId = await turn.createAgent({});
    const builtin = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['create-agent-generation'],
      preset_parameters: { agent_id: childId },
    });
    const parentId = await turn.createAgent({
      tool_bindings: [{ tool_id: builtin.id }],
    });

    const { id } = await turn.generate({
      agentId: parentId,
      calls: [
        {
          name: `${builtin.name}_create-agent-generation`,
          args: { messages: [proposeCalls([])] },
        },
      ],
    });

    const pointers = (await rowsOf(id)).filter((row) => {
      return row.type === 'generations.sub_generation_started';
    });
    expect(pointers).toEqual([
      expect.objectContaining({
        toolCallId: 'call_0',
        childGenerationId: expect.stringMatching(/^gen_/),
      }),
    ]);
    const child = await db.Generation.findOne({
      where: { publicId: pointers[0].childGenerationId as string },
    });
    expect(child?.agentPublicId).toBe(childId);
  });

  describe('GET /api/v1/generations/:generation_id/transcript', () => {
    test('a running generation shows its ended steps and the call in flight', async () => {
      const fast = await turn.createTool();
      const slow = await turn.createTool();
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      turn.target.reply(`/${slow.name}`, async () => {
        await released;
        return { body: { ok: true } };
      });
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: fast.id }, { tool_id: slow.id }],
        max_steps: 4,
      });

      const pending = turn
        .api()
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({
          messages: [
            proposeSteps([
              [{ name: fast.name, args: { amount: 1 } }],
              [{ name: slow.name, args: { amount: 2 } }],
            ]),
          ],
        })
        .then((res) => {
          return res;
        });

      const generation = await pollUntil({
        read: () => {
          return db.Generation.findOne({
            where: { agentPublicId: agentId },
          });
        },
        done: (row) => {
          return row !== null;
        },
      });
      const generationId = generation?.publicId as string;
      const inFlight = await pollUntil({
        read: () => {
          return turn
            .api()
            .get(`/api/v1/generations/${generationId}/transcript`);
        },
        done: (res) => {
          return res.body.in_flight_tool_calls?.[0]?.step_index === 1;
        },
      });
      release();

      expect(inFlight.status).toBe(200);
      expect(inFlight.body.status).toBe('running');
      expect(inFlight.body.steps).toHaveLength(1);
      expect(inFlight.body.steps[0].tool_calls).toEqual([
        expect.objectContaining({ id: 'call_0_0', tool_name: fast.name }),
      ]);
      expect(inFlight.body.in_flight_tool_calls).toEqual([
        {
          tool_call_id: 'call_1_0',
          step_index: 1,
          started_at: expect.any(String),
        },
      ]);

      const done = await pending;
      expect(done.body.status).toBe('completed');
      const settled = await turn
        .api()
        .get(`/api/v1/generations/${generationId}/transcript`);
      expect(settled.body.in_flight_tool_calls).toEqual([]);
    });
  });
});
