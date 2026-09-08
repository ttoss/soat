import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Tool } from 'ai';
import { db } from 'src/db';
import { buildResolverGuardrailContext } from 'src/lib/agentToolGuardrail';
import { resolveAgentTools } from 'src/lib/agentToolResolver';
import { clearGuardrailContextToolCache } from 'src/lib/guardrailContext';
import { evaluateGuardrailDryRun } from 'src/lib/guardrailDryRun';
import { createGuardrail } from 'src/lib/guardrails';

// A cost ceiling reads `SUM(cost_usd)`, which ignores nulls — so a window whose
// AI usage was never priced summed to a number that understated real spend and
// let the ceiling pass. The quota path answers the same window with
// `QUOTA_UNENFORCEABLE`; this pins the guardrail half, driven through the real
// resolver dispatch rather than the provider in isolation.

const invokeExecute = async (
  resolvedTool: Tool,
  input: Record<string, unknown>
): Promise<unknown> => {
  const execute = resolvedTool.execute;
  if (!execute) throw new Error('resolved tool has no execute');
  return execute(input, {
    toolCallId: 'tc_unpriced_cost',
    messages: [],
    context: undefined,
  });
};

describe('guardrail cost ceiling over an unpriced window', () => {
  let toolServer: Server;
  let toolBaseUrl: string;
  let toolRequests: Array<Record<string, unknown>> = [];

  let seq = 0;

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
  });

  afterEach(() => {
    toolRequests = [];
    clearGuardrailContextToolCache();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      toolServer.close(() => {
        return resolve();
      });
    });
  });

  // A window is per-project, so every case gets its own project — otherwise one
  // case's seeded events decide another's verdict.
  const makeProject = async (): Promise<{
    projectId: number;
    projectPublicId: string;
    agentPublicId: string;
    httpToolId: string;
    orchestrationId: number;
  }> => {
    seq += 1;
    const project = await db.Project.create({ name: `Unpriced Cost ${seq}` });
    const aiProvider = await db.AiProvider.create({
      projectId: project.id,
      name: `Unpriced Provider ${seq}`,
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: toolBaseUrl,
    });
    const agent = await db.Agent.create({
      projectId: project.id,
      aiProviderId: aiProvider.id,
      name: `Unpriced Agent ${seq}`,
    });
    const httpTool = await db.Tool.create({
      projectId: project.id,
      type: 'http',
      name: 'refund',
      description: 'Issue a refund',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' } },
      },
      execute: { url: `${toolBaseUrl}/refund`, method: 'POST' },
    });
    const orchestration = await db.Orchestration.create({
      projectId: project.id,
      name: `Unpriced Orchestration ${seq}`,
    });
    return {
      projectId: project.id,
      projectPublicId: project.publicId,
      agentPublicId: agent.publicId,
      httpToolId: httpTool.publicId,
      orchestrationId: orchestration.id,
    };
  };

  const seedEvent = async (args: {
    projectId: number;
    costUsd: string | null;
    meterType?: string;
    source?: string | null;
    orchestrationRunId?: number | null;
    /** Adds an unpriced billable component, for the partly-priced-event case. */
    unpricedComponent?: boolean;
  }): Promise<void> => {
    seq += 1;
    const event = await db.UsageEvent.create({
      projectId: args.projectId,
      orchestrationRunId: args.orchestrationRunId ?? null,
      meterType: args.meterType ?? 'llm_tokens',
      source: args.source ?? null,
      provider: 'ollama',
      model: 'stub-model',
      costUsd: args.costUsd,
      idempotencyKey: `unpriced-cost:${seq}`,
    });
    if (!args.unpricedComponent) return;
    await db.UsageComponent.create({
      usageEventId: event.id,
      component: 'output_tokens',
      quantity: '50',
      unit: 'token',
      billable: true,
      unitPrice: null,
      costUsd: null,
    });
  };

  const makeGuardrail = async (args: {
    projectId: number;
    document: object;
  }): Promise<string> => {
    const guardrail = await createGuardrail({
      projectId: args.projectId,
      name: `unpriced-cost-${Math.random().toString(36).slice(2, 10)}`,
      document: args.document,
    });
    return guardrail.id;
  };

  const resolveGuarded = async (args: {
    projectId: number;
    projectPublicId: string;
    agentPublicId: string;
    httpToolId: string;
    guardrailIds: string[];
    orchestrationRunId?: string | null;
  }): Promise<Tool> => {
    await db.Tool.update(
      { guardrailIds: args.guardrailIds },
      { where: { publicId: args.httpToolId } }
    );
    const guardrail = await buildResolverGuardrailContext({
      agentId: args.agentPublicId,
      generationId: 'gen_unpriced_cost',
      projectId: args.projectId,
      projectPublicId: args.projectPublicId,
      orchestrationRunId: args.orchestrationRunId ?? null,
    });
    const tools = await resolveAgentTools({
      toolIds: [args.httpToolId],
      projectId: args.projectId,
      projectIds: [args.projectId],
      guardrail,
    });
    return tools.refund;
  };

  const WINDOW_CEILING = {
    class: 'B',
    guard: { '<': [{ var: 'runtime.usage.cost_usd_24h' }, 100] },
  };

  const RUN_CEILING = {
    class: 'B',
    guard: {
      '<': [{ var: 'runtime.usage.orchestration_run_cost_usd' }, 100],
    },
  };

  const runCeiling = async (args: {
    projectId: number;
    projectPublicId: string;
    agentPublicId: string;
    httpToolId: string;
    document: object;
    orchestrationRunId?: string | null;
  }): Promise<{ status?: string }> => {
    const id = await makeGuardrail({
      projectId: args.projectId,
      document: args.document,
    });
    const refund = await resolveGuarded({
      projectId: args.projectId,
      projectPublicId: args.projectPublicId,
      agentPublicId: args.agentPublicId,
      httpToolId: args.httpToolId,
      guardrailIds: [id],
      orchestrationRunId: args.orchestrationRunId ?? null,
    });
    return (await invokeExecute(refund, { amount: 10 })) as { status?: string };
  };

  test('a window that metered AI spend and priced none of it fails closed', async () => {
    const project = await makeProject();
    await seedEvent({ projectId: project.projectId, costUsd: null });

    const result = await runCeiling({ ...project, document: WINDOW_CEILING });

    expect(result.status).toBe('tripwire');
    expect(toolRequests).toHaveLength(0);
  });

  test('a priced window under the ceiling executes', async () => {
    const project = await makeProject();
    await seedEvent({ projectId: project.projectId, costUsd: '1.00' });

    const result = await runCeiling({ ...project, document: WINDOW_CEILING });

    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  test('a priced window over the ceiling trips', async () => {
    const project = await makeProject();
    await seedEvent({ projectId: project.projectId, costUsd: '500.00' });

    const result = await runCeiling({ ...project, document: WINDOW_CEILING });

    expect(result.status).toBe('tripwire');
    expect(toolRequests).toHaveLength(0);
  });

  // The anti-deadlock case: a project that has not generated yet must not be
  // refused, or the generation that would price the window can never happen.
  test('a window holding no AI usage reads zero and lets the call through', async () => {
    const project = await makeProject();
    await seedEvent({
      projectId: project.projectId,
      costUsd: null,
      meterType: 'api_request',
    });

    const result = await runCeiling({ ...project, document: WINDOW_CEILING });

    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  // An embedding is priced from deployment configuration with no price-book
  // tier a tenant can reach, so counting it would refuse a ceiling nobody in
  // the project can make enforceable.
  test('an unpriced embedding does not black out the window', async () => {
    const project = await makeProject();
    await seedEvent({
      projectId: project.projectId,
      costUsd: null,
      source: 'embedding',
    });

    const result = await runCeiling({ ...project, document: WINDOW_CEILING });

    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  // Deliberately so, and now decided rather than deferred (#1228): refusing a
  // partly-priced window on a ratio would block the very generation that would
  // price it. The gap is reported through the project's `cost_usd` quota
  // instead — see `quotaUnpricedCost.test.ts`.
  test('a partly priced window still reports its priced total', async () => {
    const project = await makeProject();
    await seedEvent({ projectId: project.projectId, costUsd: '1.00' });
    await seedEvent({ projectId: project.projectId, costUsd: null });

    const result = await runCeiling({ ...project, document: WINDOW_CEILING });

    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  // The verdict stays event-level on purpose. An event whose components are
  // only partly priced carries a real cost, so reading the gap per component —
  // which is what the exception needs — must not turn a ceiling fail-closed and
  // strand a project on one missing price row.
  test('an event with an unpriced component does not black out the window', async () => {
    const project = await makeProject();
    await seedEvent({
      projectId: project.projectId,
      costUsd: '1.00',
      unpricedComponent: true,
    });

    const result = await runCeiling({ ...project, document: WINDOW_CEILING });

    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  // The dry run publishes the resolved key in `context_snapshot`, so the null is
  // part of the record a caller reads and not only an internal verdict. Driven
  // through the lib rather than added to `rest/guardrails.test.ts`, whose project
  // is shared by a case asserting this key reads `0`.
  test('the evaluation record publishes the unpriced window as null', async () => {
    const project = await makeProject();
    await seedEvent({ projectId: project.projectId, costUsd: null });
    const id = await makeGuardrail({
      projectId: project.projectId,
      document: WINDOW_CEILING,
    });

    const record = await evaluateGuardrailDryRun({
      projectIds: [project.projectId],
      guardrailId: id,
      args: { amount: 1 },
    });

    expect(record.context_snapshot['runtime.usage.cost_usd_24h']).toBeNull();
    expect(record.guard_result).toBe(false);
    expect(record.decision).toBe('tripwire');
  });

  test('the evaluation record publishes a priced window as its total', async () => {
    const project = await makeProject();
    await seedEvent({ projectId: project.projectId, costUsd: '2.50' });
    const id = await makeGuardrail({
      projectId: project.projectId,
      document: WINDOW_CEILING,
    });

    const record = await evaluateGuardrailDryRun({
      projectIds: [project.projectId],
      guardrailId: id,
      args: { amount: 1 },
    });

    expect(record.context_snapshot['runtime.usage.cost_usd_24h']).toBe(2.5);
    expect(record.guard_result).toBe(true);
    expect(record.decision).toBe('execute');
  });

  test('a run that metered AI spend and priced none of it fails closed', async () => {
    const project = await makeProject();
    const run = await db.OrchestrationRun.create({
      orchestrationId: project.orchestrationId,
      projectId: project.projectId,
      status: 'running',
    });
    await seedEvent({
      projectId: project.projectId,
      costUsd: null,
      orchestrationRunId: run.id as number,
    });

    const result = await runCeiling({
      ...project,
      document: RUN_CEILING,
      orchestrationRunId: run.publicId,
    });

    expect(result.status).toBe('tripwire');
    expect(toolRequests).toHaveLength(0);
  });

  test('a priced run under the ceiling executes', async () => {
    const project = await makeProject();
    const run = await db.OrchestrationRun.create({
      orchestrationId: project.orchestrationId,
      projectId: project.projectId,
      status: 'running',
    });
    await seedEvent({
      projectId: project.projectId,
      costUsd: '1.00',
      orchestrationRunId: run.id as number,
    });

    const result = await runCeiling({
      ...project,
      document: RUN_CEILING,
      orchestrationRunId: run.publicId,
    });

    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });
});
