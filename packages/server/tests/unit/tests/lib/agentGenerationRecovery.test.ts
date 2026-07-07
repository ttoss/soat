import { db } from 'src/db';
import { recoverPendingFromDb } from 'src/lib/agentGenerationRecovery';
import {
  createGenerationRecord,
  updateGenerationRecord,
} from 'src/lib/generations';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// `recoverPendingFromDb` rebuilds the in-memory `PendingGeneration` from a
// generation record's `metadata.pendingState` after a server restart, when the
// pending map is empty. Its happy path is exercised end-to-end through the REST
// tool-outputs route in `rest/agentGeneration.test.ts`; every failure branch,
// however, collapses to an indistinguishable `GENERATION_NOT_FOUND` (404) at
// that boundary. These tests drive the recovery function directly on the real
// DB so each branch is asserted individually and the rebuilt shape
// (resolvedModel / resolvedTools / agentConfig) — which the REST layer never
// exposes — is verified. No internal (`src/**`) module is mocked.
describe('recoverPendingFromDb (real DB)', () => {
  let adminToken: string;
  let projectPublicId: string;
  let projectDbId: number;
  let agentWithToolsId: string;
  let agentNoToolsId: string;

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
        tool_ids: [toolRes.body.id],
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
        metadata: { pendingState: buildPendingState() },
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
    // The client tool referenced by tool_ids is resolved from the real DB.
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
