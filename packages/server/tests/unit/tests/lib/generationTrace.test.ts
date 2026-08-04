import { db } from 'src/db';
import { findOrCreateTrace } from 'src/lib/generationTrace';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// findOrCreateTrace is the extracted helper createGenerationRecord uses to
// reuse-or-create a Trace inside a shared transaction (soat#815). Both
// branches — reuse and create — need direct coverage since the helper now
// lives in its own small module.
describe('findOrCreateTrace', () => {
  let agentId: number;
  let projectId: number;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'trace-helper-admin', password: 'supersecret' });
    const adminToken = await loginAs('trace-helper-admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'findOrCreateTrace Test Project' });

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectRes.body.id,
        name: 'findOrCreateTrace Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectRes.body.id,
        ai_provider_id: aiProviderRes.body.id,
        name: 'findOrCreateTrace Test Agent',
      });

    const projectRow = await db.Project.findOne({
      where: { publicId: projectRes.body.id },
    });
    const agentRow = await db.Agent.findOne({
      where: { publicId: agentRes.body.id },
    });
    projectId = projectRow!.id as number;
    agentId = agentRow!.id as number;
  });

  test('creates a new Trace when none exists for the traceId', async () => {
    const traceId = 'trc_findOrCreate_new';

    const trace = await db.sequelize.transaction(async (transaction) => {
      return findOrCreateTrace({
        traceId,
        projectId,
        agentDbId: agentId,
        transaction,
      });
    });

    expect(trace.publicId).toBe(traceId);
    expect(trace.agentId).toBe(agentId);
  });

  test('reuses the existing Trace for a traceId already created', async () => {
    const traceId = 'trc_findOrCreate_reuse';

    const first = await db.sequelize.transaction(async (transaction) => {
      return findOrCreateTrace({
        traceId,
        projectId,
        agentDbId: agentId,
        transaction,
      });
    });

    const second = await db.sequelize.transaction(async (transaction) => {
      return findOrCreateTrace({
        traceId,
        projectId,
        agentDbId: agentId,
        transaction,
      });
    });

    expect(second.id).toBe(first.id);

    const traceCount = await db.Trace.count({
      where: { publicId: traceId, projectId },
    });
    expect(traceCount).toBe(1);
  });
});
