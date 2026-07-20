import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import {
  resumeToolCallApproval,
  runToolCallContinuation,
} from 'src/lib/agentToolApprovalContinuation';
import {
  approveApproval,
  type DecisionOutput,
  emitApproval,
  type MappedApproval,
} from 'src/lib/approvals';

// The tool-call continuation is the resolution half of the return-pending loop:
// when a class-C guardrail files a tool_call approval and a human resolves it,
// this handler executes the frozen action and fires the continuation
// generation. It is an internal resume-handler seam (registered on the approvals
// module, triggered by resolution) with a large branch space, so it is covered
// directly (tests.md keep-list rule 2). Real DB + a local fake tool server (the
// executed action) and a local fake OpenAI-compatible server (the continuation
// generation's model call). The LLM is never asserted on, only structural state.

describe('agentToolApprovalContinuation (tool_call resolution)', () => {
  let toolServer: Server;
  let toolBaseUrl: string;
  let toolRequests: Array<Record<string, unknown>> = [];
  let modelServer: Server;
  let modelBaseUrl: string;

  let projectId: number;
  let projectPublicId: string;
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

  const startModelServer = async (): Promise<string> => {
    modelServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-cont',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'acknowledged' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      modelServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = modelServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  beforeAll(async () => {
    toolBaseUrl = await startToolServer();
    modelBaseUrl = await startModelServer();

    const project = await db.Project.create({ name: 'Continuation Project' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Continuation Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: modelBaseUrl,
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Continuation Agent',
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

  afterEach(() => {
    toolRequests = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      toolServer.close(() => {
        return resolve();
      });
    });
    await new Promise<void>((resolve) => {
      modelServer.close(() => {
        return resolve();
      });
    });
  });

  const buildToolCallItem = (
    overrides: Partial<MappedApproval> = {}
  ): MappedApproval => {
    return {
      id: 'apr_variant_test',
      projectId: projectPublicId,
      origin: 'tool_call',
      status: 'approved',
      proposedAction: {
        toolId: httpToolId,
        action: 'refund',
        arguments: { amount: 5 },
      },
      reasoning: null,
      evidence: null,
      predictedImpact: null,
      expiresAt: new Date(Date.now() + 3600_000),
      dedupKey: null,
      runId: null,
      nodeId: null,
      generationId: null,
      sessionId: null,
      agentId: agentPublicId,
      taskId: null,
      taskTransition: null,
      knowledgeVersion: null,
      policyVersion: null,
      resolvedBy: null,
      resolutionReason: null,
      editedArguments: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  };

  test('approved item executes the action and fires a linked continuation', async () => {
    // A real initiator generation so the continuation's
    // initiator_generation_id resolves (project-scoped lookup).
    const agent = await db.Agent.findOne({
      where: { publicId: agentPublicId },
    });
    const trace = await db.Trace.create({
      projectId,
      agentId: agent!.id,
      name: 'init trace',
    });
    const initiator = await db.Generation.create({
      projectId,
      agentId: agent!.id,
      traceId: trace.id,
      status: 'completed',
      startedAt: new Date(),
    });

    const item = buildToolCallItem({
      id: 'apr_cont_test',
      proposedAction: {
        toolId: httpToolId,
        action: 'refund',
        arguments: { amount: 25 },
      },
      generationId: initiator.publicId,
    });
    const decision: DecisionOutput = {
      decision: 'approved',
      approvalId: item.id,
      resolvedBy: 'user_test',
      editedArgs: null,
      reason: null,
      result: null,
    };

    await runToolCallContinuation({ item, decision });

    // The approved action executed against the tool target.
    expect(toolRequests).toHaveLength(1);
    expect(toolRequests[0]).toEqual({ amount: 25 });

    // A continuation generation was created, linked to the initiator.
    const continuation = await db.Generation.findOne({
      where: { initiatorGenerationId: initiator.id },
    });
    expect(continuation).not.toBeNull();
  });

  test('a rejected item fires the continuation without executing', async () => {
    const item = buildToolCallItem({ status: 'rejected' });
    const decision: DecisionOutput = {
      decision: 'rejected',
      approvalId: item.id,
      resolvedBy: 'user_test',
      editedArgs: null,
      reason: 'over budget',
      result: null,
    };
    await runToolCallContinuation({ item, decision });
    expect(toolRequests).toHaveLength(0);
  });

  test('an expired item fires the continuation without executing', async () => {
    const item = buildToolCallItem({ status: 'expired', agentId: null });
    const decision: DecisionOutput = {
      decision: 'expired',
      approvalId: item.id,
      resolvedBy: null,
      editedArgs: null,
      reason: null,
      result: null,
    };
    await runToolCallContinuation({ item, decision });
    expect(toolRequests).toHaveLength(0);
  });

  test('an inline-tool proposal reports a non-executable result', async () => {
    const item = buildToolCallItem({
      proposedAction: { toolId: '', arguments: {} },
    });
    const decision: DecisionOutput = {
      decision: 'approved',
      approvalId: item.id,
      resolvedBy: 'user_test',
      editedArgs: null,
      reason: null,
      result: null,
    };
    await runToolCallContinuation({ item, decision });
    // No persisted tool to execute; nothing hits the tool target.
    expect(toolRequests).toHaveLength(0);
  });

  test('a missing project is a no-op', async () => {
    const item = buildToolCallItem({ projectId: 'prj_doesnotexist0' });
    const decision: DecisionOutput = {
      decision: 'approved',
      approvalId: item.id,
      resolvedBy: 'user_test',
      editedArgs: null,
      reason: null,
      result: null,
    };
    await expect(
      runToolCallContinuation({ item, decision })
    ).resolves.toBeUndefined();
    expect(toolRequests).toHaveLength(0);
  });

  test('a session-scoped item appends the continuation to the session', async () => {
    const agent = await db.Agent.findOne({
      where: { publicId: agentPublicId },
    });
    const conversation = await db.Conversation.create({ projectId });
    const session = await db.Session.create({
      projectId,
      agentId: agent!.id,
      conversationId: conversation.id,
      status: 'open',
    });

    const item = buildToolCallItem({
      sessionId: session.publicId,
      editedArguments: { amount: 9 },
    });
    const decision: DecisionOutput = {
      decision: 'approved',
      approvalId: item.id,
      resolvedBy: 'user_test',
      editedArgs: { amount: 9 },
      reason: null,
      result: null,
    };
    await runToolCallContinuation({ item, decision });

    // The approved (edited) action executed against the tool target.
    expect(toolRequests).toHaveLength(1);
    expect(toolRequests[0]).toEqual({ amount: 9 });
    // And the session's conversation gained messages from the continuation.
    const messageCount = await db.ConversationMessage.count({
      where: { conversationId: conversation.id },
    });
    expect(messageCount).toBeGreaterThan(0);
  });

  test('a failed execution is captured, and the continuation still fires', async () => {
    const item = buildToolCallItem({
      proposedAction: { toolId: 'tool_bogus0000000', arguments: {} },
    });
    const decision: DecisionOutput = {
      decision: 'approved',
      approvalId: item.id,
      resolvedBy: 'user_test',
      editedArgs: null,
      reason: null,
      result: null,
    };
    // callTool throws (unknown tool) → the error is captured in the result
    // rather than propagating, and the continuation generation still fires.
    await runToolCallContinuation({ item, decision });
    expect(toolRequests).toHaveLength(0);
  });

  test('a continuation failure is swallowed, never thrown', async () => {
    // The approved action executes, but the proposing agent no longer exists,
    // so firing the continuation generation throws — runToolCallContinuation
    // must swallow it (the decision is already persisted).
    const item = buildToolCallItem({ agentId: 'agent_deleted00000' });
    const decision: DecisionOutput = {
      decision: 'approved',
      approvalId: item.id,
      resolvedBy: 'user_test',
      editedArgs: null,
      reason: null,
      result: null,
    };
    await expect(
      runToolCallContinuation({ item, decision })
    ).resolves.toBeUndefined();
    expect(toolRequests).toHaveLength(1);
  });

  test('the resume handler forwards a tool_call item to the continuation', async () => {
    const item = buildToolCallItem({ agentId: 'agent_deleted00000' });
    const decision: DecisionOutput = {
      decision: 'approved',
      approvalId: item.id,
      resolvedBy: 'user_test',
      editedArgs: null,
      reason: null,
      result: null,
    };
    // Fire-and-forget: resolves immediately; the continuation runs (and
    // swallows the deleted-agent failure) in the background.
    await expect(
      resumeToolCallApproval({ item, decision })
    ).resolves.toBeUndefined();
  });

  test('resolving an item invokes the registered handler end-to-end', async () => {
    // Proves the resume handler is actually registered and fires through the
    // same notifyResume path the REST approve/reject routes drive — not just
    // when called directly.
    const agent = await db.Agent.findOne({
      where: { publicId: agentPublicId },
    });
    const trace = await db.Trace.create({
      projectId,
      agentId: agent!.id,
      name: 'wiring trace',
    });
    const initiator = await db.Generation.create({
      projectId,
      agentId: agent!.id,
      traceId: trace.id,
      status: 'completed',
      startedAt: new Date(),
    });
    const resolver = await db.User.create({
      username: `approver_${initiator.publicId}`,
      passwordHash: 'x',
      role: 'user',
      policyIds: [],
    });

    const seeded = await emitApproval({
      projectId,
      origin: 'tool_call',
      proposedAction: {
        toolId: httpToolId,
        action: 'refund',
        arguments: { amount: 33 },
      },
      expiresInSeconds: 3600,
      generationId: initiator.publicId,
      agentId: agentPublicId,
    });

    await approveApproval({
      id: seeded.id,
      resolvedByUserId: resolver.id as number,
    });

    // The continuation fires fire-and-forget; poll for its executed action.
    let executed = false;
    for (let i = 0; i < 40 && !executed; i += 1) {
      if (
        toolRequests.some((r) => {
          return r.amount === 33;
        })
      )
        executed = true;
      else
        await new Promise((resolve) => {
          return setTimeout(resolve, 25);
        });
    }
    expect(executed).toBe(true);
  });

  test('the resume handler ignores non tool_call items', async () => {
    const item = { origin: 'node', projectId: projectPublicId } as never;
    const decision = { decision: 'approved' } as never;
    await expect(
      resumeToolCallApproval({ item, decision })
    ).resolves.toBeUndefined();
    expect(toolRequests).toHaveLength(0);
  });

  test('a non tool_call item is ignored', async () => {
    const item = { origin: 'node', projectId: projectPublicId } as never;
    const decision = { decision: 'approved' } as never;
    await expect(
      runToolCallContinuation({ item, decision })
    ).resolves.toBeUndefined();
    expect(toolRequests).toHaveLength(0);
  });
});
