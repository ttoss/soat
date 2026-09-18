import { db } from 'src/db';
import { recoverPendingFromDb } from 'src/lib/agentGenerationRecovery';
import {
  createGenerationRecord,
  updateGenerationRecord,
} from 'src/lib/generations';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// The happy path is covered through the REST tool-outputs route, but every
// failure branch collapses to an indistinguishable 404 there — so the branches
// and the rebuilt shape, which REST never exposes, are asserted directly.
describe('recoverPendingFromDb (real DB)', () => {
  let adminToken: string;
  let projectPublicId: string;
  let projectDbId: number;
  let agentWithToolsId: string;
  let agentNoToolsId: string;
  let agentWithMemoryStoreId: string;
  let agentWithDeadMcpId: string;

  // `PendingGeneration.messages` is `unknown[]` — it carries AI SDK response
  // messages alongside the prompt — so the note is narrowed rather than asserted.
  const systemMessages = (
    messages: unknown[]
  ): Array<{ role: string; content: string }> => {
    return messages.filter(
      (message): message is { role: string; content: string } => {
        return (
          typeof message === 'object' &&
          message !== null &&
          'role' in message &&
          message.role === 'system' &&
          'content' in message &&
          typeof message.content === 'string'
        );
      }
    );
  };

  const buildPendingState = () => {
    return {
      pendingToolCalls: [
        { toolCallId: 'tc_1', toolName: 'clientTool', args: { x: 1 } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
      steps: [],
      parentTraceId: 'trc_parent',
      rootTraceId: 'trc_root',
      toolContext: null,
      remainingDepth: null,
    };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'genrecovery',
      policyActions: ['agents:CreateAgent', 'agents:CreateAgentGeneration'],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectPublicId = setup.projectId;

    const project = await db.Project.findOne({
      where: { publicId: projectPublicId },
    });
    projectDbId = project!.id;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectPublicId,
        name: 'Recovery Provider',
        provider: 'openai',
        default_model: 'gpt-4o',
      });

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        name: 'clientTool',
        type: 'client',
        project_id: projectPublicId,
        parameters: { type: 'object', properties: {} },
      });

    const agentWithToolsRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectPublicId,
        ai_provider_id: aiProvRes.body.id,
        name: 'Recovery Agent With Tools',
        instructions: 'Be helpful',
        model: 'gpt-4o',
        tool_bindings: [{ tool_id: toolRes.body.id }],
        temperature: 0.7,
      });
    agentWithToolsId = agentWithToolsRes.body.id;

    const agentNoToolsRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectPublicId,
        ai_provider_id: aiProvRes.body.id,
        name: 'Recovery Agent No Tools',
      });
    agentNoToolsId = agentNoToolsRes.body.id;

    const memoryStoreRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectPublicId, name: 'Recovery MemoryStore' });

    const agentWithMemoryStoreRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectPublicId,
        ai_provider_id: aiProvRes.body.id,
        name: 'Recovery Agent With MemoryStore',
        knowledge_config: { write_memory_store_id: memoryStoreRes.body.id },
      });
    agentWithMemoryStoreId = agentWithMemoryStoreRes.body.id;

    // Port 1 refuses the connection, so the listing fails at the transport —
    // the same path a rejected credential takes, without a server to run.
    const deadMcpToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        name: 'deadDesk',
        type: 'mcp',
        project_id: projectPublicId,
        mcp: { url: 'http://127.0.0.1:1/mcp' },
      });

    const agentWithDeadMcpRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectPublicId,
        ai_provider_id: aiProvRes.body.id,
        name: 'Recovery Agent With Dead MCP',
        model: 'gpt-4o',
        tool_bindings: [{ tool_id: deadMcpToolRes.body.id }],
      });
    agentWithDeadMcpId = agentWithDeadMcpRes.body.id;
  });

  const seedGeneration = async (args: {
    publicId: string;
    agentId: string;
    traceId: string;
    withPendingState: boolean;
  }): Promise<void> => {
    await createGenerationRecord({
      publicId: args.publicId,
      projectId: projectDbId,
      agentId: args.agentId,
      traceId: args.traceId,
    });
    if (args.withPendingState) {
      await updateGenerationRecord({
        publicId: args.publicId,
        pendingState: buildPendingState(),
      });
    }
  };

  test('rebuilds the full pending generation, resolving model and tools', async () => {
    await seedGeneration({
      publicId: 'gen_recover_tools',
      agentId: agentWithToolsId,
      traceId: 'trc_recover_tools',
      withPendingState: true,
    });

    const result = await recoverPendingFromDb({
      generationId: 'gen_recover_tools',
      agentId: agentWithToolsId,
    });

    expect(result).toBeDefined();
    expect(result!.agentId).toBe(agentWithToolsId);
    expect(result!.projectId).toBe(projectDbId);
    expect(result!.projectPublicId).toBe(projectPublicId);
    expect(result!.traceId).toBe('trc_recover_tools');
    expect(result!.parentTraceId).toBe('trc_parent');
    expect(result!.rootTraceId).toBe('trc_root');
    expect(result!.generationId).toBe('gen_recover_tools');
    expect(result!.pendingToolCalls).toHaveLength(1);
    expect(result!.pendingToolCalls[0].toolCallId).toBe('tc_1');
    expect(result!.pendingToolCalls[0].toolName).toBe('clientTool');
    expect(result!.resolvedModel).toBeDefined();
    // The client tool referenced by a binding is resolved from the real DB.
    expect(Object.keys(result!.resolvedTools)).toContain('clientTool');
    expect(result!.agentConfig.instructions).toBe('Be helpful');
    expect(result!.agentConfig.temperature).toBe(0.7);
  });

  test('resolves an empty tool set for an agent without tools', async () => {
    await seedGeneration({
      publicId: 'gen_recover_notools',
      agentId: agentNoToolsId,
      traceId: 'trc_recover_notools',
      withPendingState: true,
    });

    const result = await recoverPendingFromDb({
      generationId: 'gen_recover_notools',
      agentId: agentNoToolsId,
    });

    expect(result).toBeDefined();
    expect(result!.resolvedTools).toEqual({});
    expect(result!.agentConfig.instructions).toBeNull();
  });

  // `write_memory` comes from `knowledge_config`, not `tool_bindings`, so it is
  // what exposes whether the in-memory and recovered surfaces still agree — a
  // resumed run that lost it would answer without a tool the agent has.
  test('rebuilds the knowledge-derived tools, not only the bound ones', async () => {
    await seedGeneration({
      publicId: 'gen_recover_memory',
      agentId: agentWithMemoryStoreId,
      traceId: 'trc_recover_memory',
      withPendingState: true,
    });

    const result = await recoverPendingFromDb({
      generationId: 'gen_recover_memory',
      agentId: agentWithMemoryStoreId,
    });

    expect(result).toBeDefined();
    expect(Object.keys(result!.resolvedTools)).toContain('write_memory');
  });

  // A binding can go unreachable between the turn starting and resuming, so
  // the note is derived from the surface this segment resolved, not from the
  // one the persisted history was written against.
  test('notes a binding that went unavailable while the generation was parked', async () => {
    await seedGeneration({
      publicId: 'gen_recover_deadmcp',
      agentId: agentWithDeadMcpId,
      traceId: 'trc_recover_deadmcp',
      withPendingState: true,
    });

    const result = await recoverPendingFromDb({
      generationId: 'gen_recover_deadmcp',
      agentId: agentWithDeadMcpId,
    });

    expect(result).toBeDefined();
    expect(result!.resolvedTools).toEqual({});
    const note = systemMessages(result!.messages)[0];
    expect(note).toBeDefined();
    expect(note.content).toContain('deadDesk');
    expect(note.content).toContain('unavailable');
  });

  test('recovering twice leaves one note, not two', async () => {
    await seedGeneration({
      publicId: 'gen_recover_deadmcp_twice',
      agentId: agentWithDeadMcpId,
      traceId: 'trc_recover_deadmcp_twice',
      withPendingState: true,
    });

    const first = await recoverPendingFromDb({
      generationId: 'gen_recover_deadmcp_twice',
      agentId: agentWithDeadMcpId,
    });
    await updateGenerationRecord({
      publicId: 'gen_recover_deadmcp_twice',
      pendingState: { ...buildPendingState(), messages: first!.messages },
    });

    const second = await recoverPendingFromDb({
      generationId: 'gen_recover_deadmcp_twice',
      agentId: agentWithDeadMcpId,
    });

    expect(systemMessages(second!.messages)).toHaveLength(1);
  });

  test('returns undefined when the generation record does not exist', async () => {
    const result = await recoverPendingFromDb({
      generationId: 'gen_does_not_exist',
      agentId: agentWithToolsId,
    });

    expect(result).toBeUndefined();
  });

  test('returns undefined when the generation has no pendingState', async () => {
    await seedGeneration({
      publicId: 'gen_no_pending',
      agentId: agentWithToolsId,
      traceId: 'trc_no_pending',
      withPendingState: false,
    });

    const result = await recoverPendingFromDb({
      generationId: 'gen_no_pending',
      agentId: agentWithToolsId,
    });

    expect(result).toBeUndefined();
  });

  test('returns undefined when the agentId does not match the record', async () => {
    await seedGeneration({
      publicId: 'gen_agent_mismatch',
      agentId: agentWithToolsId,
      traceId: 'trc_agent_mismatch',
      withPendingState: true,
    });

    const result = await recoverPendingFromDb({
      generationId: 'gen_agent_mismatch',
      agentId: agentNoToolsId,
    });

    expect(result).toBeUndefined();
  });

  test('returns undefined when the agent is out of the requested project scope', async () => {
    await seedGeneration({
      publicId: 'gen_scope_miss',
      agentId: agentWithToolsId,
      traceId: 'trc_scope_miss',
      withPendingState: true,
    });

    // The record and agentId match, but scoping the agent lookup to a project
    // the agent does not belong to makes `resolveAgentForGeneration` return
    // null — a distinct branch from the "record missing" case above.
    const result = await recoverPendingFromDb({
      generationId: 'gen_scope_miss',
      agentId: agentWithToolsId,
      projectIds: [projectDbId + 100000],
    });

    expect(result).toBeUndefined();
  });
});
