import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { Tool } from 'ai';
import { db } from 'src/db';
import { buildResolverGuardrailContext } from 'src/lib/agentToolGuardrail';
import { resolveAgentTools } from 'src/lib/agentToolResolver';
import { createGuardrail } from 'src/lib/guardrails';

// `runtime.<module>.<metric>.<window>` read off the `tool_execution` meter at
// evaluation time, and the meter those reads depend on: an agent's tool calls
// recorded with the attribution the guardrail scopes by. Driven through the
// resolver dispatch so the assertions cover the real gate.

const invokeExecute = async (
  resolvedTool: Tool,
  input: Record<string, unknown>
): Promise<unknown> => {
  const execute = resolvedTool.execute;
  if (!execute) throw new Error('resolved tool has no execute');
  return execute(input, {
    toolCallId: 'tc_tool_call_rate',
    messages: [],
    context: undefined,
  });
};

describe('guardrail tool-call rate context', () => {
  let toolServer: Server;
  let toolBaseUrl: string;
  let toolRequests = 0;

  let projectId: number;
  let projectPublicId: string;
  let otherProjectId: number;
  let agentId: number;
  let agentPublicId: string;
  let otherAgentId: number;
  let refundId: number;
  let refundPublicId: string;
  let lookupId: number;
  let lookupPublicId: string;
  let generationPublicId: string;

  const startToolServer = async (): Promise<string> => {
    toolServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        toolRequests += 1;
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

    const project = await db.Project.create({ name: 'Tool Call Rate Project' });
    projectId = project.id;
    projectPublicId = project.publicId;
    const otherProject = await db.Project.create({
      name: 'Tool Call Rate Other Project',
    });
    otherProjectId = otherProject.id;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Tool Call Rate Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: toolBaseUrl,
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Tool Call Rate Agent',
    });
    agentId = agent.id;
    agentPublicId = agent.publicId;
    const otherAgent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Tool Call Rate Other Agent',
    });
    otherAgentId = otherAgent.id;

    const makeTool = async (name: string) => {
      return db.Tool.create({
        projectId,
        type: 'http',
        name,
        parameters: { type: 'object', properties: {} },
        execute: { url: `${toolBaseUrl}/${name}`, method: 'POST' },
      });
    };
    const refund = await makeTool('refund');
    refundId = refund.id;
    refundPublicId = refund.publicId;
    const lookup = await makeTool('lookup');
    lookupId = lookup.id;
    lookupPublicId = lookup.publicId;

    const trace = await db.Trace.create({ projectId, agentId });
    generationPublicId = generatePublicId(PUBLIC_ID_PREFIXES.generation);
    await db.Generation.create({
      publicId: generationPublicId,
      projectId,
      agentId,
      traceId: trace.id,
      status: 'in_progress',
      startedAt: new Date(),
    });
  });

  afterEach(async () => {
    toolRequests = 0;
    await db.Tool.update(
      { guardrailIds: null },
      { where: { id: [refundId, lookupId] } }
    );
    await db.UsageEvent.destroy({
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

  // Seeds `tool_execution` events the way the recorder writes them;
  // `minutesAgo` backdates them so window boundaries can be asserted.
  const seedCalls = async (args: {
    count: number;
    minutesAgo?: number;
    projectId?: number;
    toolId?: number | null;
    agentId?: number | null;
    outcome?: string;
    guardrailIds?: string[];
    meterType?: string;
  }): Promise<void> => {
    const createdAt = new Date(Date.now() - (args.minutesAgo ?? 0) * 60 * 1000);
    for (let index = 0; index < args.count; index += 1) {
      await db.UsageEvent.create({
        projectId: args.projectId ?? projectId,
        toolId: args.toolId === undefined ? refundId : args.toolId,
        agentId: args.agentId ?? null,
        outcome: args.outcome ?? 'ok',
        guardrailIds: args.guardrailIds ?? null,
        meterType: args.meterType ?? 'tool_execution',
        provider: 'soat',
        model: 'tool-call',
        costUsd: null,
        idempotencyKey: `seed:${generatePublicId(PUBLIC_ID_PREFIXES.usageEvent)}`,
        createdAt,
      });
    }
  };

  const makeGuardrail = async (guard: object): Promise<string> => {
    const guardrail = await createGuardrail({
      createdByUserId: null,
      projectId,
      name: `tool-call-rate-${Math.random().toString(36).slice(2, 10)}`,
      document: { class: 'B', guard },
    });
    return guardrail.id;
  };

  const ceiling = (key: string, limit: number): object => {
    return { '<': [{ var: key }, limit] };
  };

  const resolveGuarded = async (opts: {
    guardrailIds: string[];
    toolIds?: string[];
  }): Promise<Record<string, Tool>> => {
    const toolIds = opts.toolIds ?? [refundPublicId];
    await db.Tool.update(
      { guardrailIds: opts.guardrailIds },
      { where: { publicId: toolIds } }
    );
    const guardrail = await buildResolverGuardrailContext({
      agentId: agentPublicId,
      generationId: generationPublicId,
      projectId,
      projectPublicId,
    });
    return resolveAgentTools({
      toolIds,
      projectId,
      projectIds: [projectId],
      guardrail,
      attribution: { generationId: generationPublicId, agentId: agentPublicId },
    });
  };

  const expectTripwire = (result: unknown): void => {
    expect(result).toMatchObject({ status: 'tripwire' });
  };

  describe('recording on the agent path', () => {
    test('an execution carries the generation, its agent and the releasing guardrail', async () => {
      const id = await makeGuardrail(
        ceiling('runtime.projects.tool_calls.24h', 100)
      );
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expect(await invokeExecute(tools.refund, {})).toEqual({ ok: true });

      const events = await db.UsageEvent.findAll({
        where: { projectId, meterType: 'tool_execution' },
      });
      expect(events).toHaveLength(1);
      const generation = await db.Generation.findOne({
        where: { publicId: generationPublicId },
      });
      expect(events[0]).toMatchObject({
        toolId: refundId,
        agentId,
        generationId: generation!.id,
        generationPublicId,
        outcome: 'ok',
        guardrailIds: [id],
      });
    });

    test('a tripped call is not recorded', async () => {
      await seedCalls({ count: 1 });
      const id = await makeGuardrail(
        ceiling('runtime.tools.tool_calls.24h', 1)
      );
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expectTripwire(await invokeExecute(tools.refund, {}));
      expect(toolRequests).toBe(0);
      expect(
        await db.UsageEvent.count({ where: { projectId, toolId: refundId } })
      ).toBe(1);
    });
  });

  describe('tools', () => {
    test('a per-day cap on one tool admits N calls and trips the next', async () => {
      const id = await makeGuardrail(
        ceiling('runtime.tools.tool_calls.24h', 2)
      );
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expect(await invokeExecute(tools.refund, {})).toEqual({ ok: true });
      expect(await invokeExecute(tools.refund, {})).toEqual({ ok: true });
      expectTripwire(await invokeExecute(tools.refund, {}));
      expect(toolRequests).toBe(2);
    });

    test("another tool's calls do not count", async () => {
      await seedCalls({ count: 5, toolId: lookupId });
      const id = await makeGuardrail(
        ceiling('runtime.tools.tool_calls.24h', 1)
      );
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expect(await invokeExecute(tools.refund, {})).toEqual({ ok: true });
    });

    test('errors counts error and timeout outcomes, not ok', async () => {
      await seedCalls({ count: 5 });
      await seedCalls({ count: 1, outcome: 'error' });
      await seedCalls({ count: 1, outcome: 'timeout' });
      const id = await makeGuardrail(ceiling('runtime.tools.errors.1h', 2));
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expectTripwire(await invokeExecute(tools.refund, {}));
    });

    test('total counts the tool’s whole history, past every rolling window', async () => {
      await seedCalls({ count: 3, minutesAgo: 60 * 24 * 60 });
      const rolling = await makeGuardrail(
        ceiling('runtime.tools.tool_calls.30d', 1)
      );
      expect(
        await invokeExecute(
          (await resolveGuarded({ guardrailIds: [rolling] })).refund,
          {}
        )
      ).toEqual({ ok: true });

      const total = await makeGuardrail(
        ceiling('runtime.tools.tool_calls.total', 3)
      );
      expectTripwire(
        await invokeExecute(
          (await resolveGuarded({ guardrailIds: [total] })).refund,
          {}
        )
      );
    });

    test('tools.name selects a per-tool cap inside one guardrail', async () => {
      await seedCalls({ count: 2, toolId: lookupId });
      const id = await makeGuardrail({
        if: [
          { '==': [{ var: 'runtime.tools.name' }, 'lookup'] },
          ceiling('runtime.tools.tool_calls.24h', 2),
          true,
        ],
      });
      const tools = await resolveGuarded({
        guardrailIds: [id],
        toolIds: [refundPublicId, lookupPublicId],
      });

      expect(await invokeExecute(tools.refund, {})).toEqual({ ok: true });
      expectTripwire(await invokeExecute(tools.lookup, {}));
    });
  });

  describe('projects', () => {
    test('the 1h window ignores calls older than an hour', async () => {
      await seedCalls({ count: 2, minutesAgo: 10 });
      await seedCalls({ count: 3, minutesAgo: 200 });

      const hour = await makeGuardrail(
        ceiling('runtime.projects.tool_calls.1h', 3)
      );
      expect(
        await invokeExecute(
          (await resolveGuarded({ guardrailIds: [hour] })).refund,
          {}
        )
      ).toEqual({ ok: true });

      const day = await makeGuardrail(
        ceiling('runtime.projects.tool_calls.24h', 3)
      );
      expectTripwire(
        await invokeExecute(
          (await resolveGuarded({ guardrailIds: [day] })).refund,
          {}
        )
      );
    });

    test('the count is project-scoped and meter-scoped', async () => {
      await seedCalls({ count: 5, projectId: otherProjectId, toolId: null });
      await seedCalls({ count: 5, meterType: 'llm_tokens', toolId: null });
      await seedCalls({ count: 1 });
      const id = await makeGuardrail(
        ceiling('runtime.projects.tool_calls.24h', 2)
      );
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expect(await invokeExecute(tools.refund, {})).toEqual({ ok: true });
    });

    test('an empty meter resolves to 0 rather than staying unresolved', async () => {
      const id = await makeGuardrail(
        ceiling('runtime.projects.tool_calls.24h', 1)
      );
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expect(await invokeExecute(tools.refund, {})).toEqual({ ok: true });
    });

    test('errors counts the project’s failed calls across tools', async () => {
      await seedCalls({ count: 1, outcome: 'error', toolId: lookupId });
      await seedCalls({ count: 1, outcome: 'timeout' });
      const id = await makeGuardrail(ceiling('runtime.projects.errors.24h', 2));
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expectTripwire(await invokeExecute(tools.refund, {}));
    });
  });

  describe('agents', () => {
    test("counts the calling agent's calls, not another agent's", async () => {
      await seedCalls({ count: 3, agentId });
      await seedCalls({ count: 5, agentId: otherAgentId });
      const id = await makeGuardrail(
        ceiling('runtime.agents.tool_calls.24h', 4)
      );
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expect(await invokeExecute(tools.refund, {})).toEqual({ ok: true });
    });
  });

  describe('guardrails', () => {
    test("counts the executions this guardrail released, not another's", async () => {
      const id = await makeGuardrail(
        ceiling('runtime.guardrails.tool_calls.24h', 4)
      );
      await seedCalls({ count: 3, guardrailIds: [id] });
      await seedCalls({ count: 5, guardrailIds: ['grd_someoneelse'] });
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expect(await invokeExecute(tools.refund, {})).toEqual({ ok: true });
    });

    test('one guardrail on several tools caps them as a set', async () => {
      const id = await makeGuardrail(
        ceiling('runtime.guardrails.tool_calls.24h', 2)
      );
      const tools = await resolveGuarded({
        guardrailIds: [id],
        toolIds: [refundPublicId, lookupPublicId],
      });

      expect(await invokeExecute(tools.refund, {})).toEqual({ ok: true });
      expect(await invokeExecute(tools.lookup, {})).toEqual({ ok: true });
      expectTripwire(await invokeExecute(tools.refund, {}));
    });
  });

  describe('orchestrations', () => {
    test('outside a run the key is unresolved and the guard fails closed', async () => {
      const id = await makeGuardrail(
        ceiling('runtime.orchestrations.tool_calls.total', 1000)
      );
      const tools = await resolveGuarded({ guardrailIds: [id] });

      expectTripwire(await invokeExecute(tools.refund, {}));
      expect(toolRequests).toBe(0);
    });
  });
});
