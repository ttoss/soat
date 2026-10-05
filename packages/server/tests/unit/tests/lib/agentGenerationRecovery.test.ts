import { db } from 'src/db';
import { recoverPendingFromDb } from 'src/lib/agentGenerationRecovery';
import {
  createGenerationRecord,
  updateGenerationRecord,
} from 'src/lib/generations';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Recovery resolves the agent through the caller's project scope and reads an
 * agent outside it as missing. Every entry point authorizes the agent in that
 * same scope first, so none can reach the refusal; it is driven directly. The
 * rebuilt turn and the refusals an entry point can produce are in
 * `rest/generationRecovery.test.ts`.
 */
describe('recoverPendingFromDb', () => {
  let projectDbId: number;
  let agentId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'genrecovery',
      policyActions: ['agents:CreateAgent'],
      createNoPermUser: false,
    });

    const project = await db.Project.findOne({
      where: { publicId: setup.projectId },
    });
    projectDbId = project!.id;

    const aiProvRes = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: setup.projectId,
        name: 'Recovery Provider',
        provider: 'openai',
        default_model: 'gpt-4o',
      });

    const agentRes = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: setup.projectId,
        ai_provider_id: aiProvRes.body.id,
        name: 'Recovery Agent',
      });
    agentId = agentRes.body.id;
  });

  test('returns undefined when the agent is out of the requested project scope', async () => {
    await createGenerationRecord({
      publicId: 'gen_scope_miss',
      projectId: projectDbId,
      agentId,
      traceId: 'trc_scope_miss',
    });
    await updateGenerationRecord({
      publicId: 'gen_scope_miss',
      status: 'requires_action',
      pendingState: {
        pendingToolCalls: [
          { toolCallId: 'tc_1', toolName: 'clientTool', args: {} },
        ],
        messages: [{ role: 'user', content: 'hello' }],
        steps: [],
        parentTraceId: null,
        rootTraceId: null,
        toolContext: null,
        remainingDepth: null,
      },
    });

    const result = await recoverPendingFromDb({
      generationId: 'gen_scope_miss',
      agentId,
      projectIds: [projectDbId + 100000],
    });

    expect(result).toBeUndefined();
  });
});
