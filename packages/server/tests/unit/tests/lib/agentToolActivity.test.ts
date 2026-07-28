import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Tool } from 'ai';
import { db } from 'src/db';
import { buildResolverGuardrailContext } from 'src/lib/agentToolGuardrail';
import { resolveAgentTools } from 'src/lib/agentToolResolver';
import { clearGuardrailContextToolCache } from 'src/lib/guardrailContext';
import { createGuardrail } from 'src/lib/guardrails';

// `action_executed` at agent-generation time (approvals PRD Phase 4, closing the
// documented v1 gap): the orchestration tool-node executor was the only
// instrumented producer, so tool calls an agent made during a generation never
// reached the feed. Driven through the resolver dispatch path — the entry point
// that builds a generation's tool set — so the assertions cover the real
// dispatch rather than the wrapper alone.

const invokeExecute = async (
  resolvedTool: Tool,
  input: Record<string, unknown>
): Promise<unknown> => {
  const execute = resolvedTool.execute;
  if (!execute) throw new Error('resolved tool has no execute');
  return execute(input, {
    toolCallId: 'tc_activity',
    messages: [],
    context: undefined,
  });
};

describe('agent-generation tool activity (resolver dispatch path)', () => {
  let toolServer: Server;
  let toolBaseUrl: string;

  let projectId: number;
  let projectPublicId: string;
  let agentPublicId: string;
  let httpToolId: string;

  const startToolServer = async (): Promise<string> => {
    toolServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on('data', () => {});
      req.on('end', () => {
        if (req.url?.startsWith('/boom')) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'upstream exploded' }));
          return;
        }
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

    const project = await db.Project.create({ name: 'Tool Activity Project' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Tool Activity Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: toolBaseUrl,
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Tool Activity Agent',
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
    clearGuardrailContextToolCache();
    await db.Tool.update(
      { guardrailIds: null },
      { where: { publicId: httpToolId } }
    );
    await db.ActivityEntry.destroy({ where: { projectId } });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      toolServer.close(() => {
        return resolve();
      });
    });
  });

  // The emit is fire-and-forget (a recording failure must never disturb the tool
  // call), so poll the observable side effect rather than sleeping a fixed span.
  const waitForEntries = async (expected: number): Promise<unknown[]> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await db.ActivityEntry.findAll({
        where: { projectId, kind: 'action_executed' },
        order: [['createdAt', 'ASC']],
      });
      if (rows.length >= expected) return rows;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    return db.ActivityEntry.findAll({
      where: { projectId, kind: 'action_executed' },
    });
  };

  const activityContext = {
    projectId: 0,
    agentId: '',
    generationId: 'gen_tool_activity',
  };

  const resolveWithActivity = async (opts?: {
    guardrailIds?: string[];
    withActivity?: boolean;
    url?: string;
  }): Promise<Tool> => {
    if (opts?.url) {
      await db.Tool.update(
        { execute: { url: opts.url, method: 'POST' } },
        { where: { publicId: httpToolId } }
      );
    }
    if (opts?.guardrailIds) {
      await db.Tool.update(
        { guardrailIds: opts.guardrailIds },
        { where: { publicId: httpToolId } }
      );
    }
    const guardrail = await buildResolverGuardrailContext({
      agentId: agentPublicId,
      generationId: 'gen_tool_activity',
      projectId,
      projectPublicId,
    });
    const tools = await resolveAgentTools({
      toolIds: [httpToolId],
      projectId,
      projectIds: [projectId],
      guardrail,
      activity:
        opts?.withActivity === false
          ? undefined
          : { ...activityContext, projectId, agentId: agentPublicId },
    });
    return tools.refund;
  };

  test('a successful generation-time tool call records an action_executed entry', async () => {
    const refund = await resolveWithActivity();

    const result = await invokeExecute(refund, { amount: 25 });
    expect(result).toEqual({ ok: true });

    const rows = (await waitForEntries(1)) as Array<{
      kind: string;
      severity: string;
      summary: string;
      detail: Record<string, unknown> | null;
      agentId: string | null;
      refId: string | null;
      orchestrationRunId: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('action_executed');
    expect(rows[0].severity).toBe('info');
    expect(rows[0].agentId).toBe(agentPublicId);
    expect(rows[0].refId).toBe(httpToolId);
    expect(rows[0].orchestrationRunId).toBeNull();
    expect(rows[0].summary).toContain('refund');
    expect(rows[0].detail).toMatchObject({
      action: 'refund',
      generationId: 'gen_tool_activity',
    });
  });

  test('a call blocked by a guardrail records no entry', async () => {
    const guardrail = await createGuardrail({
      projectId,
      name: `tool-activity-deny-${Math.random().toString(36).slice(2, 10)}`,
      document: { class: 'D' },
    });
    const refund = await resolveWithActivity({ guardrailIds: [guardrail.id] });

    const result = (await invokeExecute(refund, { amount: 25 })) as {
      status: string;
    };
    expect(result.status).toBe('blocked');

    const rows = await waitForEntries(1);
    expect(rows).toHaveLength(0);
  });

  test('a failed tool call records no entry', async () => {
    const refund = await resolveWithActivity({ url: `${toolBaseUrl}/boom` });

    await expect(invokeExecute(refund, { amount: 25 })).rejects.toThrow();

    const rows = await waitForEntries(1);
    expect(rows).toHaveLength(0);

    await db.Tool.update(
      { execute: { url: `${toolBaseUrl}/refund`, method: 'POST' } },
      { where: { publicId: httpToolId } }
    );
  });

  test('a caller that threads no activity identity records no entry', async () => {
    // The orchestration tool-node path emits at its own call site; it must not
    // gain a second entry from the resolver, and a caller with no agent in
    // scope has no identity to attribute an action to.
    const refund = await resolveWithActivity({ withActivity: false });

    const result = await invokeExecute(refund, { amount: 25 });
    expect(result).toEqual({ ok: true });

    const rows = await waitForEntries(1);
    expect(rows).toHaveLength(0);
  });

  test('an inline (ephemeral) tool call records an entry with no tool ref', async () => {
    const guardrail = await buildResolverGuardrailContext({
      agentId: agentPublicId,
      generationId: 'gen_tool_activity',
      projectId,
      projectPublicId,
    });
    const tools = await resolveAgentTools({
      toolIds: [],
      tools: [
        {
          name: 'inline_refund',
          type: 'http',
          parameters: {
            type: 'object',
            properties: { amount: { type: 'number' } },
          },
          execute: { url: `${toolBaseUrl}/refund`, method: 'POST' },
        },
      ],
      projectId,
      projectIds: [projectId],
      guardrail,
      activity: { ...activityContext, projectId, agentId: agentPublicId },
    });

    const result = await invokeExecute(tools.inline_refund, { amount: 25 });
    expect(result).toEqual({ ok: true });

    const rows = (await waitForEntries(1)) as Array<{
      agentId: string | null;
      refId: string | null;
      detail: Record<string, unknown> | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].agentId).toBe(agentPublicId);
    expect(rows[0].refId).toBeNull();
    expect(rows[0].detail).toMatchObject({ action: 'inline_refund' });
  });
});
