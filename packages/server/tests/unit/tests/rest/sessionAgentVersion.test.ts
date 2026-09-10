import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The version stamp a session carries (the sessions module doc — Which version
 * is serving).
 *
 * A pointer at what the conversation last ran, not a pin: the split is
 * assigned per turn by `resolveServedAgentVersion`, and the session only
 * records where that landed. Its own file rather than `agentVersions.test.ts`
 * because the assertions are on the session read, and that file is at its
 * length ceiling.
 *
 * Every generation here fails `502` — the AI provider is unreachable in unit
 * CI — but the version is stamped before the model is contacted, which is the
 * part under test.
 */
describe('a session records the agent version serving it', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;

  const createAgent = async (instructions: string) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        instructions,
      });
    expect(res.status).toBe(201);
    return res.body;
  };

  const openSession = async (agentId: string): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/sessions')
      .send({ agent_id: agentId });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const sessionOf = async (sessionId: string) => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/sessions/${sessionId}`
    );
    expect(res.status).toBe(200);
    return res.body;
  };

  const generateInSession = async (sessionId: string): Promise<void> => {
    await authenticatedTestClient(userToken).post(
      `/api/v1/sessions/${sessionId}/generate?wait=true`
    );
  };

  const setRelease = async (agentId: string, canaryPercent: number) => {
    const res = await authenticatedTestClient(userToken)
      .put(`/api/v1/agents/${agentId}/release`)
      .send({
        stable_version: 1,
        canary_version: 2,
        canary_percent: canaryPercent,
      });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'sessver',
      policyActions: [
        'agents:CreateAgent',
        'agents:UpdateAgent',
        'agents:SetAgentRelease',
        'agents:CreateSession',
        'agents:GetSession',
        'agents:SendSessionMessage',
      ],
      createNoPermUser: false,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Session Version Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;
  });

  test('is null until the session has generated', async () => {
    const agent = await createAgent('not run yet');

    const session = await sessionOf(await openSession(agent.id));

    expect(session.agent_version).toBeNull();
  });

  test('names the version that served the latest generation', async () => {
    const agent = await createAgent('only version');
    const sessionId = await openSession(agent.id);

    await generateInSession(sessionId);

    expect((await sessionOf(sessionId)).agent_version).toBe(1);
  }, 60000);

  test('a fork starts with no version of its own', async () => {
    const agent = await createAgent('parent has run');
    const sessionId = await openSession(agent.id);
    await generateInSession(sessionId);
    expect((await sessionOf(sessionId)).agent_version).toBe(1);

    const fork = await authenticatedTestClient(userToken)
      .post(`/api/v1/sessions/${sessionId}/fork`)
      .send({});
    expect(fork.status).toBe(201);

    // A fork may run a different agent entirely and runs nothing until it is
    // generated into — inheriting would name a config it never served.
    expect(fork.body.agent_version).toBeNull();
  }, 60000);

  test('follows the rollout the next turn is assigned to', async () => {
    const agent = await createAgent('stable prompt');
    await authenticatedTestClient(userToken)
      .put(`/api/v1/agents/${agent.id}`)
      .send({ instructions: 'canary prompt' });
    const sessionId = await openSession(agent.id);

    // Driving the split from either end makes the assignment deterministic
    // without depending on how this session's key hashes.
    await setRelease(agent.id, 0);
    await generateInSession(sessionId);

    // The live row is version 2, so this also pins that the session records
    // what actually ran rather than the agent's current version.
    expect((await sessionOf(sessionId)).agent_version).toBe(1);

    await setRelease(agent.id, 100);
    await generateInSession(sessionId);

    expect((await sessionOf(sessionId)).agent_version).toBe(2);
  }, 120000);
});
