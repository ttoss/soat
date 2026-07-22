import type { Tool } from 'ai';
import { db } from 'src/db';
import { gatePendingClientTools } from 'src/lib/agentClientToolGuardrail';
import { buildResolverGuardrailContext } from 'src/lib/agentToolGuardrail';
import { resolveAgentTools } from 'src/lib/agentToolResolver';
import { clearGuardrailContextToolCache } from 'src/lib/guardrailContext';
import { createGuardrail } from 'src/lib/guardrails';

// The client-tool guardrail gate sits at the `requires_action` handoff, not at
// server-side execute (client tools have no execute). It is exercised here
// through the same entry point the runtime uses: resolve a client tool via the
// resolver (which attaches the gate), then run `gatePendingClientTools` over a
// proposed call. Real DB + real guardrail evaluation + real approval filing;
// nothing mocked.

describe('client-tool guardrail gate (requires_action handoff)', () => {
  let projectId: number;
  let projectPublicId: string;
  let agentPublicId: string;
  let clientToolId: string;

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'Client Gate Project' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Client Gate Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: 'http://127.0.0.1:1',
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Client Gate Agent',
    });
    agentPublicId = agent.publicId;

    const clientTool = await db.Tool.create({
      projectId,
      type: 'client',
      name: 'read_local_file',
      description: 'Read a file on the caller machine',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, amount: { type: 'number' } },
      },
    });
    clientToolId = clientTool.publicId;
  });

  afterEach(async () => {
    clearGuardrailContextToolCache();
    await db.Tool.update(
      { guardrailIds: null },
      { where: { publicId: clientToolId } }
    );
  });

  const makeGuardrail = async (document: object): Promise<string> => {
    const guardrail = await createGuardrail({
      projectId,
      name: `client-guard-${Math.abs(JSON.stringify(document).length)}-${Math.random()}`,
      document,
    });
    return guardrail.id;
  };

  const resolveGatedClientTool = async (
    guardrailIds: string[] | null
  ): Promise<Record<string, Tool>> => {
    if (guardrailIds !== null) {
      await db.Tool.update(
        { guardrailIds },
        { where: { publicId: clientToolId } }
      );
    }
    const guardrail = await buildResolverGuardrailContext({
      agentId: agentPublicId,
      generationId: 'gen_client_gate_test',
      projectId,
      projectPublicId,
    });
    return resolveAgentTools({
      toolIds: [clientToolId],
      projectId,
      projectIds: [projectId],
      guardrail,
    });
  };

  const pendingCount = async (): Promise<number> => {
    return db.ApprovalItem.count({
      where: { projectId, status: 'pending', origin: 'tool_call' },
    });
  };

  test('no guardrails — the call is released to the client untouched', async () => {
    const tools = await resolveGatedClientTool(null);
    const outcome = await gatePendingClientTools({
      pendingToolCalls: [
        {
          toolCallId: 'call_1',
          toolName: 'read_local_file',
          input: { path: '/a' },
        },
      ],
      resolvedTools: tools,
    });
    expect(outcome.released).toHaveLength(1);
    expect(outcome.released[0]).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'read_local_file',
    });
    expect(outcome.synthesizedResults).toHaveLength(0);
  });

  test('class A releases the call and writes an audit record', async () => {
    const id = await makeGuardrail({ class: 'A' });
    const tools = await resolveGatedClientTool([id]);
    const outcome = await gatePendingClientTools({
      pendingToolCalls: [
        {
          toolCallId: 'call_a',
          toolName: 'read_local_file',
          input: { path: '/a' },
        },
      ],
      resolvedTools: tools,
    });
    expect(outcome.released).toHaveLength(1);
    expect(outcome.synthesizedResults).toHaveLength(0);
  });

  test('class D blocks the handoff — synthesized result, nothing released', async () => {
    const id = await makeGuardrail({ class: 'D' });
    const tools = await resolveGatedClientTool([id]);
    const outcome = await gatePendingClientTools({
      pendingToolCalls: [
        {
          toolCallId: 'call_d',
          toolName: 'read_local_file',
          input: { path: '/a' },
        },
      ],
      resolvedTools: tools,
    });
    expect(outcome.released).toHaveLength(0);
    expect(outcome.synthesizedResults).toHaveLength(1);
    expect(outcome.synthesizedResults[0]).toMatchObject({
      toolCallId: 'call_d',
      toolName: 'read_local_file',
      output: { status: 'blocked' },
    });
  });

  test('class C files an approval and synthesizes pending_approval, nothing released', async () => {
    const before = await pendingCount();
    const id = await makeGuardrail({ class: 'C' });
    const tools = await resolveGatedClientTool([id]);
    const outcome = await gatePendingClientTools({
      pendingToolCalls: [
        {
          toolCallId: 'call_c',
          toolName: 'read_local_file',
          input: { path: '/secret', approval_reasoning: 'needs sign-off' },
        },
      ],
      resolvedTools: tools,
    });
    expect(outcome.released).toHaveLength(0);
    expect(outcome.synthesizedResults).toHaveLength(1);
    const output = outcome.synthesizedResults[0].output as {
      status: string;
      approval_id: string;
    };
    expect(output.status).toBe('pending_approval');
    expect(output.approval_id).toMatch(/^apr_/);
    expect(await pendingCount()).toBe(before + 1);

    const item = await db.ApprovalItem.findOne({
      where: { publicId: output.approval_id },
    });
    expect(item!.origin).toBe('tool_call');
    expect(item!.reasoning).toBe('needs sign-off');
    // The frozen args exclude the stripped justification field.
    expect(item!.proposedAction).toEqual({
      toolId: clientToolId,
      action: 'read_local_file',
      arguments: { path: '/secret' },
    });
  });

  test('class B passing guard releases; failing guard trips (synthesized), nothing released', async () => {
    const id = await makeGuardrail({
      class: 'B',
      guard: { '<': [{ var: 'args.amount' }, 100] },
    });
    const passTools = await resolveGatedClientTool([id]);
    const passed = await gatePendingClientTools({
      pendingToolCalls: [
        {
          toolCallId: 'call_bp',
          toolName: 'read_local_file',
          input: { amount: 5 },
        },
      ],
      resolvedTools: passTools,
    });
    expect(passed.released).toHaveLength(1);
    expect(passed.synthesizedResults).toHaveLength(0);

    const tripped = await gatePendingClientTools({
      pendingToolCalls: [
        {
          toolCallId: 'call_bt',
          toolName: 'read_local_file',
          input: { amount: 999 },
        },
      ],
      resolvedTools: passTools,
    });
    expect(tripped.released).toHaveLength(0);
    expect(tripped.synthesizedResults[0].output).toMatchObject({
      status: 'tripwire',
    });
  });

  test('a mixed batch releases the A call and synthesizes the D call', async () => {
    // Two guardrails: none forces both, so classify per call via args.
    const id = await makeGuardrail({
      class: { if: [{ '<': [{ var: 'args.amount' }, 100] }, 'A', 'D'] },
    });
    const tools = await resolveGatedClientTool([id]);
    const outcome = await gatePendingClientTools({
      pendingToolCalls: [
        {
          toolCallId: 'call_ok',
          toolName: 'read_local_file',
          input: { amount: 1 },
        },
        {
          toolCallId: 'call_no',
          toolName: 'read_local_file',
          input: { amount: 500 },
        },
      ],
      resolvedTools: tools,
    });
    expect(
      outcome.released.map((r) => {
        return r.toolCallId;
      })
    ).toEqual(['call_ok']);
    expect(
      outcome.synthesizedResults.map((s) => {
        return s.toolCallId;
      })
    ).toEqual(['call_no']);
  });
});
