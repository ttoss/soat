import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { Tool } from 'ai';
import { db } from 'src/db';
import { buildResolverGuardrailContext } from 'src/lib/agentToolGuardrail';
import { resolveAgentTools } from 'src/lib/agentToolResolver';
import { clearGuardrailContextToolCache } from 'src/lib/guardrailContext';
import { createGuardrail } from 'src/lib/guardrails';

// The per-run cumulative ceiling (#486). `runtime.usage.cost_usd_*` / `tokens_*`
// are windowed per project — the wrong granularity for aborting a single
// runaway run — so `runtime.usage.run_tokens` / `run_cost_usd` sum only the meter
// rows recorded against the current run so far.
//
// Driven through the resolver dispatch path (the entry point that builds a
// generation's tool set), exactly as `agentToolGuardrailGate.test.ts` does, so
// the assertions cover the real gate rather than the context builder alone.

const invokeExecute = async (
  resolvedTool: Tool,
  input: Record<string, unknown>
): Promise<unknown> => {
  const execute = resolvedTool.execute;
  if (!execute) throw new Error('resolved tool has no execute');
  return execute(input, {
    toolCallId: 'tc_run_ceiling',
    messages: [],
    context: undefined,
  });
};

describe('guardrail per-run usage ceiling', () => {
  let toolServer: Server;
  let toolBaseUrl: string;
  let toolRequests: Array<Record<string, unknown>> = [];

  let projectId: number;
  let projectPublicId: string;
  let agentPublicId: string;
  let httpToolId: string;
  let orchestrationId: number;

  const startToolServer = async (): Promise<string> => {
    toolServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        toolRequests.push(raw ? JSON.parse(raw) : {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      toolServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = toolServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  beforeAll(async () => {
    toolBaseUrl = await startToolServer();

    const project = await db.Project.create({ name: 'Run Ceiling Project' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Run Ceiling Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: toolBaseUrl,
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Run Ceiling Agent',
    });
    agentPublicId = agent.publicId;

    const httpTool = await db.Tool.create({
      projectId,
      type: 'http',
      name: 'refund',
      description: 'Issue a refund',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' } },
      },
      execute: { url: `${toolBaseUrl}/refund`, method: 'POST' },
    });
    httpToolId = httpTool.publicId;

    const orchestration = await db.Orchestration.create({
      projectId,
      name: 'Run Ceiling Orchestration',
    });
    orchestrationId = orchestration.id;
  });

  afterEach(async () => {
    toolRequests = [];
    clearGuardrailContextToolCache();
    await db.Tool.update(
      { guardrailIds: null },
      { where: { publicId: httpToolId } }
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      toolServer.close(() => {
        return resolve();
      });
    });
  });

  const createRun = async (): Promise<{ id: number; publicId: string }> => {
    const run = await db.OrchestrationRun.create({
      orchestrationId,
      projectId,
      status: 'running',
    });
    return { id: run.id as number, publicId: run.publicId };
  };

  // Seeds one metered LLM call against a run, the same shape
  // `recordGenerationUsage` writes when a generation runs inside a node.
  const seedRunUsage = async (args: {
    runInternalId: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: string;
  }): Promise<void> => {
    const event = await db.UsageEvent.create({
      projectId,
      orchestrationRunId: args.runInternalId,
      nodeId: 'node-a',
      meterType: 'llm_tokens',
      provider: 'ollama',
      model: 'stub-model',
      costUsd: args.costUsd,
      idempotencyKey: `seed:${args.runInternalId}:${args.inputTokens}:${args.outputTokens}`,
    });
    await db.UsageComponent.bulkCreate([
      {
        publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
        usageEventId: event.id,
        component: 'input_tokens',
        quantity: String(args.inputTokens),
        unit: 'token',
        billable: true,
      },
      {
        publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
        usageEventId: event.id,
        component: 'output_tokens',
        quantity: String(args.outputTokens),
        unit: 'token',
        billable: true,
      },
    ]);
  };

  const makeGuardrail = async (document: object): Promise<string> => {
    const guardrail = await createGuardrail({
      projectId,
      name: `run-ceiling-${Math.random().toString(36).slice(2, 10)}`,
      document,
    });
    return guardrail.id;
  };

  const resolveGuarded = async (opts: {
    guardrailIds: string[];
    orchestrationRunId?: string | null;
    guardrailContext?: Record<string, unknown>;
  }): Promise<Tool> => {
    await db.Tool.update(
      { guardrailIds: opts.guardrailIds },
      { where: { publicId: httpToolId } }
    );
    const guardrail = await buildResolverGuardrailContext({
      agentId: agentPublicId,
      generationId: 'gen_run_ceiling',
      projectId,
      projectPublicId,
      orchestrationRunId: opts.orchestrationRunId ?? null,
      guardrailContext: opts.guardrailContext,
    });
    const tools = await resolveAgentTools({
      toolIds: [httpToolId],
      projectId,
      projectIds: [projectId],
      guardrail,
    });
    return tools.refund;
  };

  const TOKEN_CEILING_GUARD = {
    class: 'B',
    guard: {
      '<': [
        { var: 'runtime.usage.run_tokens' },
        { var: 'context.action_token_ceiling' },
      ],
    },
  };

  test('run under the token ceiling executes', async () => {
    const run = await createRun();
    await seedRunUsage({
      runInternalId: run.id,
      inputTokens: 600,
      outputTokens: 400,
      costUsd: '2.50',
    });

    const id = await makeGuardrail(TOKEN_CEILING_GUARD);
    const refund = await resolveGuarded({
      guardrailIds: [id],
      orchestrationRunId: run.publicId,
      guardrailContext: { action_token_ceiling: 5000 },
    });

    const result = await invokeExecute(refund, { amount: 10 });
    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  test('run over the token ceiling trips fail-closed before the tool runs', async () => {
    const run = await createRun();
    await seedRunUsage({
      runInternalId: run.id,
      inputTokens: 600,
      outputTokens: 400,
      costUsd: '2.50',
    });

    const id = await makeGuardrail(TOKEN_CEILING_GUARD);
    const refund = await resolveGuarded({
      guardrailIds: [id],
      orchestrationRunId: run.publicId,
      guardrailContext: { action_token_ceiling: 500 },
    });

    const result = (await invokeExecute(refund, { amount: 10 })) as {
      status: string;
    };
    expect(result.status).toBe('tripwire');
    expect(toolRequests).toHaveLength(0);
  });

  test('run_tokens counts only the current run, not the whole project', async () => {
    const noisyRun = await createRun();
    await seedRunUsage({
      runInternalId: noisyRun.id,
      inputTokens: 90_000,
      outputTokens: 10_000,
      costUsd: '900.00',
    });

    const quietRun = await createRun();
    await seedRunUsage({
      runInternalId: quietRun.id,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: '0.01',
    });

    const id = await makeGuardrail(TOKEN_CEILING_GUARD);
    const refund = await resolveGuarded({
      guardrailIds: [id],
      orchestrationRunId: quietRun.publicId,
      guardrailContext: { action_token_ceiling: 1000 },
    });

    // The other run's 100k tokens must not leak into this run's total.
    const result = await invokeExecute(refund, { amount: 10 });
    expect(result).toEqual({ ok: true });
  });

  test('run_cost_usd sums the run cost and trips over its ceiling', async () => {
    const run = await createRun();
    await seedRunUsage({
      runInternalId: run.id,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: '4.00',
    });
    await seedRunUsage({
      runInternalId: run.id,
      inputTokens: 20,
      outputTokens: 5,
      costUsd: '3.50',
    });

    const id = await makeGuardrail({
      class: 'B',
      guard: {
        '<': [
          { var: 'runtime.usage.run_cost_usd' },
          { var: 'context.action_cost_ceiling' },
        ],
      },
    });
    const refund = await resolveGuarded({
      guardrailIds: [id],
      orchestrationRunId: run.publicId,
      // 4.00 + 3.50 = 7.50 spent, over the 5.00 ceiling.
      guardrailContext: { action_cost_ceiling: 5 },
    });

    const result = (await invokeExecute(refund, { amount: 10 })) as {
      status: string;
    };
    expect(result.status).toBe('tripwire');
    expect(toolRequests).toHaveLength(0);
  });

  test('a run with no metered usage yet reads zero, not null', async () => {
    const run = await createRun();

    const id = await makeGuardrail(TOKEN_CEILING_GUARD);
    const refund = await resolveGuarded({
      guardrailIds: [id],
      orchestrationRunId: run.publicId,
      guardrailContext: { action_token_ceiling: 1 },
    });

    // 0 < 1 — a fresh run passes rather than failing closed on a missing key.
    const result = await invokeExecute(refund, { amount: 10 });
    expect(result).toEqual({ ok: true });
  });

  test('outside a run the key is unresolvable and the guard fails closed', async () => {
    const id = await makeGuardrail(TOKEN_CEILING_GUARD);
    const refund = await resolveGuarded({
      guardrailIds: [id],
      orchestrationRunId: null,
      guardrailContext: { action_token_ceiling: 5000 },
    });

    const result = (await invokeExecute(refund, { amount: 10 })) as {
      status: string;
    };
    expect(result.status).toBe('tripwire');
    expect(toolRequests).toHaveLength(0);
  });
});
