import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { pollUntil } from '../../fixtures/poll';
import { proposeCalls, type ScriptedCall } from '../../fixtures/scriptedModel';

/**
 * A generation running past `GENERATION_DEADLINE_MS` is cancelled: the tool
 * call it waits on stops holding it, whatever the tool's type, and the
 * generation fails for the deadline.
 */

const DEADLINE_MS = '600';

describe('POST /api/v1/agents/{agent_id}/generate past the deadline', () => {
  let turn: AgentToolTurn;
  let savedDeadline: string | undefined;
  const releases: Array<() => void> = [];

  /** A target path that answers only once the test is over. */
  const hangingPath = (args?: { mcp?: boolean }): string => {
    const path = `/${turn.unique('hang')}`;
    turn.target.reply(path, (body) => {
      if (args?.mcp && body.method !== 'tools/call') {
        const result =
          body.method === 'tools/list'
            ? { tools: [{ name: 'slow' }] }
            : { protocolVersion: '2025-06-18', capabilities: {} };
        return { body: { jsonrpc: '2.0', id: body.id, result } };
      }
      return new Promise((resolve) => {
        releases.push(() => {
          resolve({ body: { ok: true } });
        });
      });
    });
    return path;
  };

  const httpToolAt = (path: string) => {
    return turn.createTool({
      execute: { url: `${turn.target.baseUrl}${path}`, method: 'POST' },
    });
  };

  const hangingHttpTool = () => {
    return httpToolAt(hangingPath());
  };

  /** Whether the call the turn abandoned at `path` was itself cancelled. */
  const expectAbandoned = async (path: string) => {
    const abandoned = await pollUntil({
      read: async () => {
        return turn.target.requestsAt(path).some((request) => {
          return request.abandoned;
        });
      },
      done: Boolean,
    });
    expect(abandoned).toBe(true);
  };

  const expectCancelled = async (args: {
    toolId: string;
    call: ScriptedCall;
    agent?: Record<string, unknown>;
  }) => {
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: args.toolId }],
      ...args.agent,
    });
    const res = await turn
      .api()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [proposeCalls([args.call])] });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('GENERATION_DEADLINE_EXCEEDED');
    const generation = await turn
      .api()
      .get(`/api/v1/generations/${res.body.error.meta.generation_id}`);
    expect(generation.body.status).toBe('failed');
    expect(generation.body.error.code).toBe('GENERATION_DEADLINE_EXCEEDED');
  };

  beforeAll(async () => {
    savedDeadline = process.env.GENERATION_DEADLINE_MS;
    process.env.GENERATION_DEADLINE_MS = DEADLINE_MS;
    turn = await startAgentToolTurn({ prefix: 'gendeadline' });
  });

  afterAll(async () => {
    if (savedDeadline === undefined) delete process.env.GENERATION_DEADLINE_MS;
    else process.env.GENERATION_DEADLINE_MS = savedDeadline;
    for (const release of releases) release();
    await turn.close();
  });

  test('cancels an http tool call', async () => {
    const tool = await hangingHttpTool();

    await expectCancelled({
      toolId: tool.id,
      call: { name: tool.name, args: { amount: 1 } },
    });
  });

  test('cancels a pipeline tool call', async () => {
    const step = await hangingHttpTool();
    const pipeline = await turn.createTool({
      type: 'pipeline',
      execute: undefined,
      parameters: { type: 'object', properties: {} },
      pipeline: {
        steps: [{ id: 'one', tool_id: step.id, input: { amount: 1 } }],
      },
    });

    await expectCancelled({
      toolId: pipeline.id,
      call: { name: pipeline.name, args: {} },
    });
  });

  test('cancels an mcp tool call', async () => {
    const tool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${hangingPath({ mcp: true })}` },
    });

    await expectCancelled({
      toolId: tool.id,
      call: { name: 'slow', args: {} },
    });
  });

  test('cancels a builtin tool call', async () => {
    const step = await hangingHttpTool();
    const childId = await turn.createAgent({
      tool_bindings: [{ tool_id: step.id }],
    });
    const builtin = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['create-agent-generation'],
      preset_parameters: { agent_id: childId },
    });

    await expectCancelled({
      toolId: builtin.id,
      call: {
        name: `${builtin.name}_create-agent-generation`,
        args: {
          messages: [proposeCalls([{ name: step.name, args: { amount: 1 } }])],
        },
      },
    });
  });

  test('stops an mcp call it abandons', async () => {
    const path = hangingPath({ mcp: true });
    const tool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${path}` },
    });

    await expectCancelled({
      toolId: tool.id,
      call: { name: 'slow', args: {} },
    });

    await expectAbandoned(path);
  });

  test('stops a pipeline it abandons before its next step', async () => {
    const hangPath = hangingPath();
    const nextPath = `/${turn.unique('next')}`;
    const [first, second] = await Promise.all([
      httpToolAt(hangPath),
      httpToolAt(nextPath),
    ]);
    const pipeline = await turn.createTool({
      type: 'pipeline',
      execute: undefined,
      parameters: { type: 'object', properties: {} },
      pipeline: {
        steps: [
          { id: 'one', tool_id: first.id, input: { amount: 1 } },
          { id: 'two', tool_id: second.id, input: { amount: 2 } },
        ],
      },
    });

    await expectCancelled({
      toolId: pipeline.id,
      call: { name: pipeline.name, args: {} },
    });
    for (const release of releases.splice(0)) release();

    await expectAbandoned(hangPath);
    expect(turn.target.requestsAt(nextPath)).toHaveLength(0);
  });
});
