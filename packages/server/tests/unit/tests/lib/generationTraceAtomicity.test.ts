import { db } from 'src/db';
import { createGeneration } from 'src/lib/agentGeneration';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// The Trace row was once created before the Generation with no shared
// transaction, so a failed `Generation.create` left an orphaned Trace —
// invisible to the generations listing, but enough to trip `deleteAgent`'s
// no-dependents precondition with a 409. `Generation.create` is spied to
// reject once, the sanctioned force-failure pattern.
describe('createGenerationRecord — Trace/Generation atomicity', () => {
  test('a Generation.create failure does not leave an orphaned Trace behind', async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'atomicity-admin', password: 'supersecret' });
    const adminToken = await loginAs('atomicity-admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'generation trace atomicity project' });

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectRes.body.id,
        name: 'atomicity Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectRes.body.id,
        ai_provider_id: aiProviderRes.body.id,
        name: 'atomicity Test Agent',
      });

    const agentId = agentRes.body.id as string;

    const generationCreateSpy = jest
      .spyOn(db.Generation, 'create')
      .mockRejectedValueOnce(new Error('simulated transient DB failure'));

    // Ollama isn't reachable in this environment, so the generation itself
    // fails downstream regardless — that's fine, the only thing under test
    // is whether the record-keeping write leaves an orphaned Trace.
    await createGeneration({
      agentId,
      messages: [{ role: 'user', content: 'hello' }],
    }).catch(() => {});

    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    generationCreateSpy.mockRestore();

    const listRes = await authenticatedTestClient(adminToken).get(
      `/api/v1/generations?agent_id=${agentId}`
    );
    expect(listRes.body.total).toBe(0);

    // The Generation.create failure rolls the Trace insert back with it, so
    // the agent has no dependents and deletes cleanly. An orphaned Trace would
    // trip deleteAgent's dependents check and force a 409 though no Generation
    // ever existed.
    const deleteRes = await authenticatedTestClient(adminToken).delete(
      `/api/v1/agents/${agentId}`
    );
    expect(deleteRes.status).toBe(204);
  });
});
