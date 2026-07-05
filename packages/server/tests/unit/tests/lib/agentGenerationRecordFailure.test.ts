import { createGeneration } from 'src/lib/agentGeneration';
import * as generationsModule from 'src/lib/generations';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// `resolveContextAndRecord` fires off `createGenerationRecord` without
// awaiting it (`.catch(() => {})`), so a DB failure while recording the
// generation must never surface to the caller. Exercised with a real
// agent/provider (no `jest.doMock`/module-registry isolation) so the
// cross-module `createGenerationRecord` import can be spied on directly.
describe('createGeneration — createGenerationRecord failure is swallowed', () => {
  test('does not throw when createGenerationRecord rejects', async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    const adminToken = await loginAs('admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'createGenerationRecord failure Test Project' });

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectRes.body.id,
        name: 'record-failure Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectRes.body.id,
        ai_provider_id: aiProviderRes.body.id,
        name: 'record-failure Test Agent',
      });

    jest
      .spyOn(generationsModule, 'createGenerationRecord')
      .mockRejectedValueOnce(new Error('db unavailable'));

    // Ollama isn't reachable in this environment, so the generation itself
    // fails downstream — that's fine; the only thing under test is that the
    // fire-and-forget record-creation failure doesn't produce an unhandled
    // rejection or otherwise crash the call.
    await createGeneration({
      agentId: agentRes.body.id,
      messages: [{ role: 'user', content: 'hello' }],
    }).catch(() => {});

    // Flush the microtask queue so the fire-and-forget `.catch` handler runs.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    jest.restoreAllMocks();
  });
});
