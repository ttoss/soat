import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Tool } from 'ai';
import { db } from 'src/db';
import { gatePendingClientTools } from 'src/lib/agentClientToolGuardrail';
import { buildResolverGuardrailContext } from 'src/lib/agentToolGuardrail';
import { resolveAgentTools } from 'src/lib/agentToolResolver';
import { createGuardrail } from 'src/lib/guardrails';

// A guardrail's context tool is called with the proposed call nested under
// `call`, on every gated call. The agent-turn and client-tool gates have no
// entry point short of a model turn, so they are driven through the resolver;
// the other gate sites are pinned in `rest/guardrailContextTool.test.ts`.

describe('guardrail context tool input', () => {
  let server: Server;
  let baseUrl: string;
  let contextRequests: Array<Record<string, unknown>> = [];
  // What `/context` answers; by default it echoes the call's args back so a
  // guard can compare them against its own `args.*`.
  let contextResponder: (
    body: Record<string, unknown>
  ) => Record<string, unknown> = (body) => {
    return { echoed: body };
  };

  let projectId: number;
  let projectPublicId: string;
  let agentPublicId: string;
  let contextToolId: string;
  let refundToolId: string;
  let clientToolId: string;

  const startServer = async (): Promise<string> => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/context') {
          contextRequests.push(body);
          res.end(JSON.stringify(contextResponder(body)));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  beforeAll(async () => {
    baseUrl = await startServer();

    const project = await db.Project.create({ name: 'Context Input Project' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Context Input Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl,
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Context Input Agent',
    });
    agentPublicId = agent.publicId;

    contextToolId = (
      await db.Tool.create({
        projectId,
        type: 'http',
        name: 'fetch-context',
        execute: { url: `${baseUrl}/context`, method: 'POST' },
      })
    ).publicId;

    refundToolId = (
      await db.Tool.create({
        projectId,
        type: 'http',
        name: 'refund',
        parameters: {
          type: 'object',
          properties: { amount: { type: 'number' } },
        },
        presetParameters: { currency: 'usd' },
        execute: { url: `${baseUrl}/refund`, method: 'POST' },
      })
    ).publicId;

    clientToolId = (
      await db.Tool.create({
        projectId,
        type: 'client',
        name: 'read_local_file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      })
    ).publicId;
  });

  afterEach(async () => {
    contextRequests = [];
    contextResponder = (body) => {
      return { echoed: body };
    };
    await db.Tool.update(
      { guardrailIds: null },
      { where: { publicId: [refundToolId, clientToolId] } }
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        return resolve();
      });
    });
  });

  const attachGuardrail = async (args: {
    toolId: string;
    document?: object;
  }): Promise<string> => {
    const guardrail = await createGuardrail({
      createdByUserId: null,
      projectId,
      name: `context-input-${Math.random()}`,
      document: args.document ?? { class: 'A' },
      contextToolId,
      contextMode: 'merge',
    });
    await db.Tool.update(
      { guardrailIds: [guardrail.id] },
      { where: { publicId: args.toolId } }
    );
    return guardrail.id;
  };

  const resolveForAgent = async (toolId: string): Promise<Tool[]> => {
    const guardrail = await buildResolverGuardrailContext({
      agentId: agentPublicId,
      generationId: 'gen_context_input',
      projectId,
      projectPublicId,
    });
    const tools = await resolveAgentTools({
      attribution: {},
      toolIds: [toolId],
      projectId,
      projectIds: [projectId],
      guardrail,
    });
    return Object.values(tools);
  };

  const invokeExecute = async (
    resolvedTool: Tool,
    input: Record<string, unknown>
  ): Promise<unknown> => {
    const execute = resolvedTool.execute;
    if (!execute) throw new Error('resolved tool has no execute');
    return execute(input, {
      toolCallId: 'tc_context_input',
      messages: [],
      context: undefined,
    });
  };

  const refundCall = (args: Record<string, unknown>) => {
    return {
      call: {
        action: 'refund',
        tool: { id: refundToolId, name: 'refund' },
        args,
      },
    };
  };

  test('agent turn: the context tool receives the proposed call under `call`', async () => {
    await attachGuardrail({ toolId: refundToolId });
    const [refund] = await resolveForAgent(refundToolId);

    const result = await invokeExecute(refund, {
      amount: 5,
      approval_reasoning: 'customer asked',
      currency: 'eur',
    });

    expect(result).toEqual({ ok: true });
    // Presets pinned over the model's args, justification fields removed.
    expect(contextRequests).toEqual([
      refundCall({ amount: 5, currency: 'usd' }),
    ]);
    expect(Object.keys(contextRequests[0])).toEqual(['call']);
  });

  test("agent turn: `call.args` are the guard's `args.*`", async () => {
    contextResponder = (body) => {
      const call = body.call as { args: Record<string, unknown> };
      return { echoed_args: call.args };
    };
    await attachGuardrail({
      toolId: refundToolId,
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
            {
              '==': [
                { var: 'context.echoed_args.currency' },
                { var: 'args.currency' },
              ],
            },
            { '==': [{ var: 'args.currency' }, 'usd'] },
            { '!': [{ var: 'context.echoed_args.approval_reasoning' }] },
          ],
        },
      },
    });
    const [refund] = await resolveForAgent(refundToolId);

    const result = await invokeExecute(refund, {
      amount: 12,
      approval_reasoning: 'because',
    });
    expect(result).toEqual({ ok: true });
  });

  test('two identical gated calls in a row make two context-tool calls', async () => {
    await attachGuardrail({ toolId: refundToolId });
    const [refund] = await resolveForAgent(refundToolId);

    await invokeExecute(refund, { amount: 1 });
    await invokeExecute(refund, { amount: 1 });
    await invokeExecute(refund, { amount: 2 });

    expect(contextRequests).toEqual([
      refundCall({ amount: 1, currency: 'usd' }),
      refundCall({ amount: 1, currency: 'usd' }),
      refundCall({ amount: 2, currency: 'usd' }),
    ]);
  });

  test('a context tool that ignores its input still resolves `context.*`', async () => {
    contextResponder = () => {
      return { tier: 'high' };
    };
    await attachGuardrail({
      toolId: refundToolId,
      document: {
        class: { if: [{ '==': [{ var: 'context.tier' }, 'high'] }, 'C', 'A'] },
      },
    });
    const [refund] = await resolveForAgent(refundToolId);

    const result = (await invokeExecute(refund, { amount: 1 })) as {
      status: string;
    };
    expect(result.status).toBe('pending_approval');
  });

  test('client tool: the handoff gate passes the proposed call', async () => {
    await attachGuardrail({ toolId: clientToolId });
    const guardrail = await buildResolverGuardrailContext({
      agentId: agentPublicId,
      generationId: 'gen_context_input_client',
      projectId,
      projectPublicId,
    });
    const resolvedTools = await resolveAgentTools({
      attribution: {},
      toolIds: [clientToolId],
      projectId,
      projectIds: [projectId],
      guardrail,
    });

    const outcome = await gatePendingClientTools({
      pendingToolCalls: [
        {
          toolCallId: 'call_ctx',
          toolName: 'read_local_file',
          input: { path: '/etc/hosts', approval_reasoning: 'x' },
        },
      ],
      resolvedTools,
    });

    expect(outcome.released).toHaveLength(1);
    expect(contextRequests).toEqual([
      {
        call: {
          action: 'read_local_file',
          tool: { id: clientToolId, name: 'read_local_file' },
          args: { path: '/etc/hosts' },
        },
      },
    ]);
  });
});
