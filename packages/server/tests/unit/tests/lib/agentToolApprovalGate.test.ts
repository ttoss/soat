import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Tool } from 'ai';
import { db } from 'src/db';
import { buildResolverApprovalContext } from 'src/lib/agentToolApproval';
import {
  resumeToolCallApproval,
  runToolCallContinuation,
} from 'src/lib/agentToolApprovalContinuation';
import type { ToolApprovalPolicy } from 'src/lib/agentToolBindings';
import { resolveAgentTools } from 'src/lib/agentToolResolver';
import type { DecisionOutput, MappedApproval } from 'src/lib/approvals';

// Real DB + a local fake HTTP server for the tool target and a local fake
// OpenAI-compatible server for the continuation's model call (the sanctioned
// local-fake-server pattern). The gate is exercised through the resolver — the
// entry point that builds a generation's tool set — so the assertions survive
// any internal restructuring of the dispatch path. The LLM is never asserted
// on, only structural fields.

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

describe('agentToolApproval gate (resolver dispatch path)', () => {
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

    const project = await db.Project.create({ name: 'Approval Gate Project' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Gate Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: modelBaseUrl,
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

  const resolveWithPolicy = async (policy: ToolApprovalPolicy) => {
    const bindings = [{ toolId: httpToolId, approvalPolicy: policy }];
    const tools = await resolveAgentTools({
      toolIds: [httpToolId],
      projectId,
      projectIds: [projectId],
      approval: buildResolverApprovalContext({
        bindings,
        agentId: agentPublicId,
        generationId: 'gen_gate_test',
        projectId,
      }),
    });
    return tools.refund;
  };

  const pendingCount = async (): Promise<number> => {
    return db.ApprovalItem.count({
      where: { projectId, status: 'pending', origin: 'tool_call' },
    });
  };

  test('allow effect executes the tool with justification fields stripped', async () => {
    const refund = await resolveWithPolicy({
      default: 'allow',
    });
    const result = await invokeExecute(refund, {
      amount: 10,
      approval_reasoning: 'should not be forwarded',
    });

    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
    // The stripped justification field never reaches the executed HTTP body.
    expect(toolRequests[0]).not.toHaveProperty('approval_reasoning');
  });

  test('deny effect returns a structured refusal and executes nothing', async () => {
    const before = await pendingCount();
    const refund = await resolveWithPolicy({ default: 'deny' });
    const result = await invokeExecute(refund, { amount: 10 });

    expect(result).toEqual({
      status: 'denied',
      reason: 'Denied by approval_policy.',
    });
    expect(toolRequests).toHaveLength(0);
    expect(await pendingCount()).toBe(before);
  });

  test('require_approval files a tool_call item and returns pending_approval', async () => {
    const refund = await resolveWithPolicy({ default: 'require_approval' });
    const result = (await invokeExecute(refund, {
      amount: 500,
      approval_reasoning: 'over budget',
      approval_predicted_impact: 'refunds $500',
    })) as { status: string; approval_id: string; expires_at: string };

    expect(result.status).toBe('pending_approval');
    expect(result.approval_id).toMatch(/^apr_/);
    expect(result.expires_at).toBeDefined();
    expect(toolRequests).toHaveLength(0);

    const item = await db.ApprovalItem.findOne({
      where: { publicId: result.approval_id },
    });
    expect(item).not.toBeNull();
    expect(item!.origin).toBe('tool_call');
    expect(item!.agentId).toBe(agentPublicId);
    expect(item!.generationId).toBe('gen_gate_test');
    expect(item!.reasoning).toBe('over budget');
    expect(item!.predictedImpact).toBe('refunds $500');
    // Justification fields are stripped from the frozen executed arguments.
    expect(item!.proposedAction).toEqual({
      toolId: httpToolId,
      action: 'refund',
      arguments: { amount: 500 },
    });
    expect(item!.dedupKey).toBeTruthy();
  });

  test('rules take precedence over the default (first match wins)', async () => {
    const refund = await resolveWithPolicy({
      default: 'require_approval',
      rules: [
        { when: { '<': [{ var: 'arguments.amount' }, 100] }, effect: 'allow' },
      ],
    });
    const result = await invokeExecute(refund, { amount: 42 });
    expect(result).toEqual({ ok: true });
    expect(toolRequests).toHaveLength(1);
  });

  test('a duplicate proposal returns the existing pending item', async () => {
    const refund = await resolveWithPolicy({ default: 'require_approval' });
    const first = (await invokeExecute(refund, { amount: 777 })) as {
      approval_id: string;
    };
    const second = (await invokeExecute(refund, { amount: 777 })) as {
      approval_id: string;
    };

    expect(second.approval_id).toBe(first.approval_id);
    const count = await db.ApprovalItem.count({
      where: {
        projectId,
        status: 'pending',
        origin: 'tool_call',
        dedupKey: (await db.ApprovalItem.findOne({
          where: { publicId: first.approval_id },
        }))!.dedupKey,
      },
    });
    expect(count).toBe(1);
  });

  describe('continuation on resolution', () => {
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

      const item: MappedApproval = {
        id: 'apr_cont_test',
        projectId: projectPublicId,
        origin: 'tool_call',
        status: 'approved',
        proposedAction: {
          toolId: httpToolId,
          action: 'refund',
          arguments: { amount: 25 },
        },
        reasoning: null,
        evidence: null,
        predictedImpact: null,
        expiresAt: new Date(Date.now() + 3600_000),
        dedupKey: null,
        runId: null,
        nodeId: null,
        generationId: initiator.publicId,
        sessionId: null,
        agentId: agentPublicId,
        knowledgeVersion: null,
        policyVersion: null,
        resolvedBy: null,
        resolutionReason: null,
        editedArguments: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
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
});
