import { buildGenerationContext } from 'src/lib/agentGenerationContext';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A pin whose archive is gone degrades to the live row (the evaluations module
 * doc — Version pinning). No entry point can name such a pin: a run validates
 * its `agent_version` at start and archives are removed only with their agent,
 * so the archive can go missing only when the non-transactional v1 archive
 * write after an agent create fails. The served config and version are what
 * the run is pinned on, so `buildGenerationContext` — the chokepoint every
 * fresh generation passes through — is driven directly. The pins an entry
 * point can produce are in `rest/evaluationVersionPin.test.ts`.
 */
describe('buildGenerationContext — pinned agent version', () => {
  let agentId: string;

  const V1_INSTRUCTIONS = 'Answer in one word.';
  const V2_INSTRUCTIONS = 'Answer in full sentences.';

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'evalpin-admin', password: 'supersecret' });
    const adminToken = await loginAs('evalpin-admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'eval pinning project' });

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectRes.body.id,
        name: 'evalpin Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectRes.body.id,
        ai_provider_id: aiProviderRes.body.id,
        name: 'evalpin Agent',
        instructions: V1_INSTRUCTIONS,
      });
    agentId = agentRes.body.id;

    // A second version, so the live row and the archive genuinely differ.
    const updated = await authenticatedTestClient(adminToken)
      .patch(`/api/v1/agents/${agentId}`)
      .send({ instructions: V2_INSTRUCTIONS });
    expect(updated.body.version).toBe(2);
  });

  test('a pin with no archived config degrades to the live row rather than failing', async () => {
    const ctx = await buildGenerationContext({
      agentId,
      messages: [{ role: 'user', content: 'hi' }],
      pinnedAgentVersion: 99,
    });

    expect(ctx.agentVersion).toBe(2);
    expect(ctx.typedAgent.instructions).toBe(V2_INSTRUCTIONS);
  });
});
