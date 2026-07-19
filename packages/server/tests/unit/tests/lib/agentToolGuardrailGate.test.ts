import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Tool } from 'ai';
import { db } from 'src/db';
import { buildResolverGuardrailContext } from 'src/lib/agentToolGuardrail';
import { resolveAgentTools } from 'src/lib/agentToolResolver';
import { clearGuardrailContextToolCache } from 'src/lib/guardrailContext';
import { createGuardrail } from 'src/lib/guardrails';

// Real DB + a local fake HTTP server for the tool target (and the guardrail
// context tool). The guardrail interceptor is exercised through the resolver —
// the entry point that builds a generation's tool set — so the assertions
// survive any internal restructuring of the dispatch path.

const invokeExecute = async (
  resolvedTool: Tool,
  input: Record<string, unknown>
): Promise<unknown> => {
  const execute = resolvedTool.execute;
  if (!execute) throw new Error('resolved tool has no execute');
  return execute(input, {
    toolCallId: 'tc_test',
    messages: [],
    context: undefined,
  });
};

describe('agentToolGuardrail gate (resolver dispatch path)', () => {
  let toolServer: Server;
  let toolBaseUrl: string;
  let toolRequests: Array<Record<string, unknown>> = [];
  let contextResponse: Record<string, unknown> = {};

  let projectId: number;
  let projectPublicId: string;
  let agentPublicId: string;
  let httpToolId: string;
  let contextToolId: string;
  let slowContextToolId: string;

  const startToolServer = async (): Promise<string> => {
    toolServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        if (req.url === '/context-slow') {
          // Respond after a delay so a tightened timeout fires first.
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(contextResponse));
          }, 300);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/context') {
          res.end(JSON.stringify(contextResponse));
          return;
        }
        toolRequests.push(raw ? JSON.parse(raw) : {});
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

    const project = await db.Project.create({ name: 'Guardrail Gate Project' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Gate Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: toolBaseUrl,
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Gate Agent',
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

    const contextTool = await db.Tool.create({
      projectId,
      type: 'http',
      name: 'fetch-context',
      description: 'Fetch fresh guardrail context',
      execute: { url: `${toolBaseUrl}/context`, method: 'POST' },
    });
    contextToolId = contextTool.publicId;

    const slowContextTool = await db.Tool.create({
      projectId,
      type: 'http',
      name: 'fetch-context-slow',
      description: 'A slow guardrail context tool',
      execute: { url: `${toolBaseUrl}/context-slow`, method: 'POST' },
    });
    slowContextToolId = slowContextTool.publicId;
  });

  afterEach(async () => {
    toolRequests = [];
    contextResponse = {};
    clearGuardrailContextToolCache();
    // Reset the tool-scope attachment between cases.
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

  const makeGuardrail = async (
    document: object,
    opts?: { contextToolId?: string; contextMode?: string }
  ): Promise<string> => {
    const guardrail = await createGuardrail({
      projectId,
      name: `guard-${Math.abs(JSON.stringify(document).length)}-${toolRequests.length}`,
      document,
      contextToolId: opts?.contextToolId,
      contextMode: opts?.contextMode,
    });
    return guardrail.id;
  };

  const resolveGuarded = async (opts: {
    toolGuardrailIds?: string[];
    projectGuardrailIds?: string[];
    agentGuardrailIds?: string[];
    guardrailContext?: Record<string, unknown>;
  }): Promise<Tool> => {
    if (opts.toolGuardrailIds !== undefined) {
      await db.Tool.update(
        { guardrailIds: opts.toolGuardrailIds },
        { where: { publicId: httpToolId } }
      );
    }
    const guardrail = await buildResolverGuardrailContext({
      agentId: agentPublicId,
      generationId: 'gen_guard_test',
      projectId,
      projectPublicId,
      projectGuardrailIds: opts.projectGuardrailIds,
      agentGuardrailIds: opts.agentGuardrailIds,
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

  const pendingCount = async (): Promise<number> => {
    return db.ApprovalItem.count({
      where: { projectId, status: 'pending', origin: 'tool_call' },
    });
  };

  const evaluationCount = async (): Promise<number> => {
    return db.GuardrailEvaluation.count({ where: { projectId } });
  };

  // The audit rows are written fire-and-forget; poll a bounded window for the
  // count to reach the target rather than sleeping a fixed interval.
  const waitForEvaluationCount = async (target: number): Promise<number> => {
    for (let i = 0; i < 40; i += 1) {
      const count = await evaluationCount();
      if (count >= target) return count;
      await new Promise((r) => {
        return setTimeout(r, 25);
      });
    }
    return evaluationCount();
  };

  test('no guardrails attached — the tool executes untouched (zero overhead)', async () => {
    const refund = await resolveGuarded({});
    const result = await invokeExecute(refund, { amount: 10 });
    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  test('class A executes and writes an audit record', async () => {
    const before = await evaluationCount();
    const id = await makeGuardrail({ class: 'A' });
    const refund = await resolveGuarded({ toolGuardrailIds: [id] });
    const result = await invokeExecute(refund, { amount: 10 });

    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
    expect(await waitForEvaluationCount(before + 1)).toBe(before + 1);
  });

  test('class D blocks and executes nothing', async () => {
    const id = await makeGuardrail({ class: 'D' });
    const refund = await resolveGuarded({ toolGuardrailIds: [id] });
    const result = await invokeExecute(refund, { amount: 10 });

    expect(result).toEqual({
      status: 'blocked',
      reason: 'Blocked by a guardrail (class D).',
    });
    expect(toolRequests).toHaveLength(0);
  });

  test('class C files a tool_call approval and returns pending_approval', async () => {
    const before = await pendingCount();
    const id = await makeGuardrail({ class: 'C' });
    const refund = await resolveGuarded({ toolGuardrailIds: [id] });
    const result = (await invokeExecute(refund, {
      amount: 500,
      approval_reasoning: 'needs sign-off',
    })) as { status: string; approval_id: string; expires_at: string };

    expect(result.status).toBe('pending_approval');
    expect(result.approval_id).toMatch(/^apr_/);
    expect(toolRequests).toHaveLength(0);
    expect(await pendingCount()).toBe(before + 1);

    const item = await db.ApprovalItem.findOne({
      where: { publicId: result.approval_id },
    });
    expect(item!.origin).toBe('tool_call');
    expect(item!.reasoning).toBe('needs sign-off');
    expect(item!.proposedAction).toEqual({
      toolId: httpToolId,
      action: 'refund',
      arguments: { amount: 500 },
    });
    expect(item!.policyVersion).toBe(`${id}@1`);
  });

  test('class B executes when the guard passes', async () => {
    const id = await makeGuardrail({
      class: 'B',
      guard: { '<': [{ var: 'args.amount' }, 100] },
    });
    const refund = await resolveGuarded({ toolGuardrailIds: [id] });
    const result = await invokeExecute(refund, { amount: 42 });
    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  test('class B trips (tripwire) when the guard fails and escalate is off', async () => {
    const id = await makeGuardrail({
      class: 'B',
      guard: { '<': [{ var: 'args.amount' }, 100] },
    });
    const refund = await resolveGuarded({ toolGuardrailIds: [id] });
    const result = (await invokeExecute(refund, { amount: 999 })) as {
      status: string;
    };
    expect(result.status).toBe('tripwire');
    expect(toolRequests).toHaveLength(0);
  });

  test('class B routes to approval when the guard fails and escalate is on', async () => {
    const before = await pendingCount();
    const id = await makeGuardrail({
      class: 'B',
      guard: { '<': [{ var: 'args.amount' }, 100] },
      escalate: true,
    });
    const refund = await resolveGuarded({ toolGuardrailIds: [id] });
    const result = (await invokeExecute(refund, { amount: 999 })) as {
      status: string;
    };
    expect(result.status).toBe('pending_approval');
    expect(await pendingCount()).toBe(before + 1);
  });

  test('composition is stricter-wins across scopes (project C beats tool A)', async () => {
    const toolA = await makeGuardrail({ class: 'A' });
    const projectC = await makeGuardrail({ class: 'C' });
    const refund = await resolveGuarded({
      toolGuardrailIds: [toolA],
      projectGuardrailIds: [projectC],
    });
    const result = (await invokeExecute(refund, { amount: 1 })) as {
      status: string;
    };
    expect(result.status).toBe('pending_approval');
    expect(toolRequests).toHaveLength(0);
  });

  test('a class expression reads the caller guardrail_context', async () => {
    const id = await makeGuardrail({
      class: {
        if: [{ '==': [{ var: 'context.tier' }, 'high'] }, 'C', 'A'],
      },
    });

    const routed = (await invokeExecute(
      await resolveGuarded({
        toolGuardrailIds: [id],
        guardrailContext: { tier: 'high' },
      }),
      { amount: 1 }
    )) as { status: string };
    expect(routed.status).toBe('pending_approval');

    const executed = await invokeExecute(
      await resolveGuarded({
        toolGuardrailIds: [id],
        guardrailContext: { tier: 'low' },
      }),
      { amount: 1 }
    );
    expect(executed).toEqual({ ok: true });
  });

  test('a context tool supplies context.* at evaluation time (merge)', async () => {
    contextResponse = { tier: 'high' };
    const id = await makeGuardrail(
      {
        class: {
          if: [{ '==': [{ var: 'context.tier' }, 'high'] }, 'C', 'A'],
        },
      },
      { contextToolId, contextMode: 'merge' }
    );
    const refund = await resolveGuarded({ toolGuardrailIds: [id] });
    const first = (await invokeExecute(refund, { amount: 1 })) as {
      status: string;
    };
    expect(first.status).toBe('pending_approval');
    // A second gated call within the TTL is served from the context-tool cache.
    const second = (await invokeExecute(refund, { amount: 2 })) as {
      status: string;
    };
    expect(second.status).toBe('pending_approval');
  });

  test('context tool in replace mode substitutes the caller context', async () => {
    contextResponse = { tier: 'high' };
    const id = await makeGuardrail(
      {
        class: {
          if: [{ '==': [{ var: 'context.tier' }, 'high'] }, 'C', 'A'],
        },
      },
      { contextToolId, contextMode: 'replace' }
    );
    // Caller says 'low', the tool says 'high'; replace means the tool wins.
    const refund = await resolveGuarded({
      toolGuardrailIds: [id],
      guardrailContext: { tier: 'low' },
    });
    const result = (await invokeExecute(refund, { amount: 1 })) as {
      status: string;
    };
    expect(result.status).toBe('pending_approval');
  });

  test('a failing context tool fails closed (caller context only)', async () => {
    const id = await makeGuardrail(
      {
        class: {
          if: [{ '==': [{ var: 'context.tier' }, 'high'] }, 'C', 'A'],
        },
      },
      // A context tool id that does not resolve — callTool throws, caught as null.
      { contextToolId: 'tool_missing0000000', contextMode: 'merge' }
    );
    const refund = await resolveGuarded({ toolGuardrailIds: [id] });
    // No caller context + failed tool → context.tier is null → class A → execute.
    const result = await invokeExecute(refund, { amount: 1 });
    expect(result).toEqual({ ok: true });
  });

  test('a context tool that times out fails closed', async () => {
    contextResponse = { tier: 'high' };
    process.env.SOAT_GUARDRAIL_CONTEXT_TIMEOUT_MS = '50';
    try {
      const id = await makeGuardrail(
        {
          class: {
            if: [{ '==': [{ var: 'context.tier' }, 'high'] }, 'C', 'A'],
          },
        },
        { contextToolId: slowContextToolId, contextMode: 'merge' }
      );
      const refund = await resolveGuarded({ toolGuardrailIds: [id] });
      // The tool takes 300ms; the 50ms timeout fires first → context.tier is
      // null → class A → execute (fail closed to the caller context, which is
      // empty here).
      const result = await invokeExecute(refund, { amount: 1 });
      expect(result).toEqual({ ok: true });
    } finally {
      delete process.env.SOAT_GUARDRAIL_CONTEXT_TIMEOUT_MS;
    }
  });

  test('a guard reads windowed soat.usage.* at evaluation time', async () => {
    const id = await makeGuardrail({
      class: 'B',
      // No usage events in this project → cost is 0, under the ceiling → passes.
      guard: { '<': [{ var: 'soat.usage.cost_usd_24h' }, 1000] },
    });
    const refund = await resolveGuarded({ toolGuardrailIds: [id] });
    const result = await invokeExecute(refund, { amount: 1 });
    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  test('a dangling reference fails closed to class C', async () => {
    const id = await makeGuardrail({ class: 'A' });
    // Attach, then delete the guardrail directly so the reference dangles.
    await db.Tool.update(
      { guardrailIds: [id] },
      { where: { publicId: httpToolId } }
    );
    await db.Guardrail.destroy({ where: { publicId: id } });

    const guardrail = await buildResolverGuardrailContext({
      agentId: agentPublicId,
      generationId: 'gen_guard_test',
      projectId,
      projectPublicId,
    });
    const tools = await resolveAgentTools({
      toolIds: [httpToolId],
      projectId,
      projectIds: [projectId],
      guardrail,
    });
    const result = (await invokeExecute(tools.refund, { amount: 1 })) as {
      status: string;
    };
    expect(result.status).toBe('pending_approval');
    expect(toolRequests).toHaveLength(0);
  });

  test('a duplicate class-C proposal returns the existing pending item', async () => {
    const id = await makeGuardrail({ class: 'C' });
    const refund = await resolveGuarded({ toolGuardrailIds: [id] });
    const first = (await invokeExecute(refund, { amount: 5 })) as {
      approval_id: string;
    };
    const second = (await invokeExecute(refund, { amount: 5 })) as {
      approval_id: string;
    };
    expect(second.approval_id).toBe(first.approval_id);
  });
});
