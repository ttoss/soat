import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { buildGenerationContext } from 'src/lib/agentGenerationContext';

// Task 2.7 — the per-binding `approval_policy` is deprecated and NO LONGER
// honoured as a routing source: guardrails are the single tool-call gating
// mechanism. The field stays readable/writable for one deprecation window
// (validated on write, echoed on read), but a live generation never routes on
// it. This is asserted through the production entry point (`buildGenerationContext`,
// the seam that builds a generation's tool set) — not the retained gate
// machinery — so it survives any internal restructuring of the dispatch path.

const invokeExecute = async (
  execute: NonNullable<
    Awaited<
      ReturnType<typeof buildGenerationContext>
    >['resolvedTools'][string]['execute']
  >,
  input: Record<string, unknown>
): Promise<unknown> => {
  return execute(input, {
    toolCallId: 'tc_test',
    messages: [],
    context: undefined,
  });
};

describe('approval_policy is no longer a routing source (task 2.7)', () => {
  let toolServer: Server;
  let toolBaseUrl: string;
  let toolRequests: Array<Record<string, unknown>> = [];

  let projectId: number;

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

    const project = await db.Project.create({ name: 'Approval Deprecation' });
    projectId = project.id;
  });

  afterEach(() => {
    toolRequests = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      toolServer.close(() => {
        return resolve();
      });
    });
  });

  const pendingCount = async (): Promise<number> => {
    return db.ApprovalItem.count({
      where: { projectId, status: 'pending', origin: 'tool_call' },
    });
  };

  const buildAgentWithPolicy = async (): Promise<string> => {
    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Deprecation Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: toolBaseUrl,
    });
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
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Deprecation Agent',
      // A binding that, before 2.7, would have gated every call on approval.
      toolBindings: [
        {
          toolId: httpTool.publicId,
          approvalPolicy: { default: 'require_approval' },
        },
      ],
    });
    return agent.publicId;
  };

  test('a require_approval binding executes the tool and files no approval item', async () => {
    const agentId = await buildAgentWithPolicy();
    const before = await pendingCount();

    const context = await buildGenerationContext({
      agentId,
      projectIds: [projectId],
      messages: [{ role: 'user', content: 'refund the order' }],
    });

    const execute = context.resolvedTools.refund?.execute;
    expect(execute).toBeDefined();

    const result = await invokeExecute(execute!, { amount: 500 });

    // The tool executed directly — approval_policy was ignored as a routing
    // source, and no approval item was filed.
    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
    expect(await pendingCount()).toBe(before);
  });
});
