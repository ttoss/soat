import { buildGenerationContext } from 'src/lib/agentGenerationContext';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// The identity keys were once pinned only on the session path, so the
// direct-agent and conversation paths forwarded a caller-forged identity into
// outbound headers and the guardrail context (#850/#851). The pin now lives at
// the shared chokepoint, which no entry point can forget.
describe('buildGenerationContext — server identity pinning', () => {
  let agentId: string;
  let sessionId: string;
  let actorId: string;
  const actorExternalId = '+15559876543';

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'ctxpin-admin', password: 'supersecret' });
    const adminToken = await loginAs('ctxpin-admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'ctx pinning project' });

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectRes.body.id,
        name: 'ctxpin Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectRes.body.id,
        ai_provider_id: aiProviderRes.body.id,
        name: 'ctxpin Agent',
      });
    agentId = agentRes.body.id;

    const actorRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/actors')
      .send({
        project_id: projectRes.body.id,
        name: 'ctxpin Actor',
        external_id: actorExternalId,
      });
    actorId = actorRes.body.id;

    const sessionRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, name: 'ctxpin Session', actor_id: actorId });
    sessionId = sessionRes.body.id;
  });

  test('a caller-forged identity is stripped on a path with no session (direct-agent shape)', async () => {
    const ctx = await buildGenerationContext({
      agentId,
      messages: [{ role: 'user', content: 'hello' }],
      toolContext: {
        session_id: 'ses_forged',
        actor_id: 'act_forged',
        actor_external_id: 'forged-external',
        userId: 'usr_legit',
      },
    });

    expect(ctx.toolContext).toEqual({ userId: 'usr_legit' });
  });

  test('the session identity is stamped over a caller-forged bag (session/conversation shape)', async () => {
    const ctx = await buildGenerationContext({
      agentId,
      messages: [{ role: 'user', content: 'hello' }],
      sessionId,
      toolContext: {
        session_id: 'ses_forged',
        actor_id: 'act_forged',
        actor_external_id: 'forged-external',
        userId: 'usr_legit',
      },
    });

    expect(ctx.toolContext).toEqual({
      userId: 'usr_legit',
      session_id: sessionId,
      actor_id: actorId,
      actor_external_id: actorExternalId,
    });
  });

  test('a casing variant of a reserved key cannot smuggle the header through', async () => {
    const ctx = await buildGenerationContext({
      agentId,
      messages: [{ role: 'user', content: 'hello' }],
      toolContext: { Session_ID: 'ses_forged', ACTOR_ID: 'act_forged' },
    });

    expect(ctx.toolContext).toEqual({});
  });
});
