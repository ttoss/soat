import { buildGenerationContext } from 'src/lib/agentGenerationContext';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The version pin an eval run relies on (docs/prd-evaluations.md — Version
 * pinning).
 *
 * Asserted here rather than through `POST /evals/{id}/runs`, because the REST
 * suite replaces `createGeneration` with `mockCreateGeneration` — so the pin
 * never reaches config resolution there and the served instructions cannot be
 * observed. `buildGenerationContext` is the chokepoint every fresh generation
 * passes through, so driving it directly is what proves the pinned run really
 * executes the archived config rather than the live row.
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

  test('with no pin, the live draft config is served', async () => {
    const ctx = await buildGenerationContext({
      agentId,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(ctx.agentVersion).toBe(2);
    expect(ctx.typedAgent.instructions).toBe(V2_INSTRUCTIONS);
  });

  test('a pinned version serves that version’s archived config', async () => {
    const ctx = await buildGenerationContext({
      agentId,
      messages: [{ role: 'user', content: 'hi' }],
      pinnedAgentVersion: 1,
    });

    expect(ctx.agentVersion).toBe(1);
    expect(ctx.typedAgent.instructions).toBe(V1_INSTRUCTIONS);
  });

  test('pinning the live version is a no-op that still stamps it', async () => {
    const ctx = await buildGenerationContext({
      agentId,
      messages: [{ role: 'user', content: 'hi' }],
      pinnedAgentVersion: 2,
    });

    expect(ctx.agentVersion).toBe(2);
    expect(ctx.typedAgent.instructions).toBe(V2_INSTRUCTIONS);
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
