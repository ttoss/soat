import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Tool } from 'ai';
import { db } from 'src/db';
import { buildResolverGuardrailContext } from 'src/lib/agentToolGuardrail';
import { resolveAgentTools } from 'src/lib/agentToolResolver';
import { clearGuardrailContextToolCache } from 'src/lib/guardrailContext';
import { createGuardrail } from 'src/lib/guardrails';

// `runtime.activity.actions_1h` / `actions_24h` (approvals PRD task 5.4): the
// project's autonomous-action rate, read off the activity feed at evaluation
// time so a guardrail can cap how many actions an agent takes per window.
//
// Driven through the resolver dispatch path (the entry point that builds a
// generation's tool set), exactly as `guardrailRunCeiling.test.ts` does, so the
// assertions cover the real gate rather than the context builder alone.

const invokeExecute = async (
  resolvedTool: Tool,
  input: Record<string, unknown>
): Promise<unknown> => {
  const execute = resolvedTool.execute;
  if (!execute) throw new Error('resolved tool has no execute');
  return execute(input, {
    toolCallId: 'tc_activity_rate',
    messages: [],
    context: undefined,
  });
};

describe('guardrail activity-rate context', () => {
  let toolServer: Server;
  let toolBaseUrl: string;
  let toolRequests: Array<Record<string, unknown>> = [];

  let projectId: number;
  let projectPublicId: string;
  let otherProjectId: number;
  let agentPublicId: string;
  let httpToolId: string;

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

    const project = await db.Project.create({ name: 'Activity Rate Project' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const otherProject = await db.Project.create({
      name: 'Activity Rate Other Project',
    });
    otherProjectId = otherProject.id;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Activity Rate Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: toolBaseUrl,
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Activity Rate Agent',
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
  });

  afterEach(async () => {
    toolRequests = [];
    clearGuardrailContextToolCache();
    await db.Tool.update(
      { guardrailIds: null },
      { where: { publicId: httpToolId } }
    );
    await db.ActivityEntry.destroy({
      where: { projectId: [projectId, otherProjectId] },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      toolServer.close(() => {
        return resolve();
      });
    });
  });

  // Seeds executed-action entries, the same shape the activity producers write.
  // `minutesAgo` backdates them so window boundaries can be asserted.
  const seedActions = async (args: {
    count: number;
    minutesAgo?: number;
    projectId?: number;
    kind?: 'action_executed' | 'schedule_fired';
  }): Promise<void> => {
    const now = Date.now();
    const createdAt = new Date(now - (args.minutesAgo ?? 0) * 60 * 1000);
    for (let index = 0; index < args.count; index += 1) {
      await db.ActivityEntry.create({
        projectId: args.projectId ?? projectId,
        kind: args.kind ?? 'action_executed',
        severity: 'info',
        summary: `seeded action ${index}`,
        createdAt,
      });
    }
  };

  const makeGuardrail = async (document: object): Promise<string> => {
    const guardrail = await createGuardrail({
      projectId,
      name: `activity-rate-${Math.random().toString(36).slice(2, 10)}`,
      document,
    });
    return guardrail.id;
  };

  const resolveGuarded = async (opts: {
    guardrailIds: string[];
    guardrailContext?: Record<string, unknown>;
  }): Promise<Tool> => {
    await db.Tool.update(
      { guardrailIds: opts.guardrailIds },
      { where: { publicId: httpToolId } }
    );
    const guardrail = await buildResolverGuardrailContext({
      agentId: agentPublicId,
      generationId: 'gen_activity_rate',
      projectId,
      projectPublicId,
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

  const RATE_CEILING_GUARD_24H = {
    class: 'B',
    guard: {
      '<': [
        { var: 'runtime.activity.actions_24h' },
        { var: 'context.action_rate_ceiling' },
      ],
    },
  };

  const RATE_CEILING_GUARD_1H = {
    class: 'B',
    guard: {
      '<': [
        { var: 'runtime.activity.actions_1h' },
        { var: 'context.action_rate_ceiling' },
      ],
    },
  };

  test('project under the 24h action ceiling executes', async () => {
    await seedActions({ count: 3 });

    const id = await makeGuardrail(RATE_CEILING_GUARD_24H);
    const refund = await resolveGuarded({
      guardrailIds: [id],
      guardrailContext: { action_rate_ceiling: 10 },
    });

    const result = await invokeExecute(refund, { amount: 10 });
    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  test('project over the 24h action ceiling trips before the tool runs', async () => {
    await seedActions({ count: 4 });

    const id = await makeGuardrail(RATE_CEILING_GUARD_24H);
    const refund = await resolveGuarded({
      guardrailIds: [id],
      guardrailContext: { action_rate_ceiling: 4 },
    });

    const result = (await invokeExecute(refund, { amount: 10 })) as {
      status: string;
    };
    expect(result.status).toBe('tripwire');
    expect(toolRequests).toHaveLength(0);
  });

  test('actions_1h ignores actions older than the 1h window', async () => {
    // Two actions inside the hour, three outside it: a ceiling of 3 passes on
    // `actions_1h` (2 < 3) and would fail on `actions_24h` (5 < 3 is false).
    await seedActions({ count: 2, minutesAgo: 10 });
    await seedActions({ count: 3, minutesAgo: 200 });

    const id = await makeGuardrail(RATE_CEILING_GUARD_1H);
    const refund = await resolveGuarded({
      guardrailIds: [id],
      guardrailContext: { action_rate_ceiling: 3 },
    });

    const result = await invokeExecute(refund, { amount: 10 });
    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  test('the count is project-scoped and kind-scoped', async () => {
    // Neither another project's actions nor this project's non-action kinds
    // count toward the ceiling: only `action_executed` in this project does.
    await seedActions({ count: 5, projectId: otherProjectId });
    await seedActions({ count: 5, kind: 'schedule_fired' });
    await seedActions({ count: 1 });

    const id = await makeGuardrail(RATE_CEILING_GUARD_24H);
    const refund = await resolveGuarded({
      guardrailIds: [id],
      guardrailContext: { action_rate_ceiling: 2 },
    });

    const result = await invokeExecute(refund, { amount: 10 });
    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  test('an empty feed resolves to 0 rather than staying unresolved', async () => {
    // The distinction matters: unresolved would fail closed on an unsafe
    // comparison, so a project that has taken no actions yet must read as 0 and
    // let a rate ceiling pass.
    const id = await makeGuardrail(RATE_CEILING_GUARD_24H);
    const refund = await resolveGuarded({
      guardrailIds: [id],
      guardrailContext: { action_rate_ceiling: 1 },
    });

    const result = await invokeExecute(refund, { amount: 10 });
    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });
});
