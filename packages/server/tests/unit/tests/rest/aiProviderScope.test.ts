import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  startStubChatProvider,
  type StubChatProvider,
} from '../../fixtures/stubChatProvider';
import { authenticatedTestClient } from '../../testClient';

/**
 * A provider record is the credential an agent generates with, so resolving
 * one is scoped to the project doing the resolving. The write paths refuse a
 * cross-project pin; this is the half underneath them: a stored row holding
 * such a pin anyway resolves to nothing rather than to another project's
 * secret.
 */
describe('POST /api/v1/agents/:agent_id/generate — a cross-project provider pin', () => {
  let adminToken: string;
  let agentId: string;
  let otherProject: StubChatProvider;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'providerscope',
      policyActions: [],
      createNoPermUser: false,
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    otherProject = await startStubChatProvider();

    const createProvider = async (args: {
      project: string;
      baseUrl: string;
    }) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: args.project,
          name: `scope-provider-${args.project}`,
          provider: 'ollama',
          default_model: 'scope-model',
          base_url: args.baseUrl,
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    const ownProviderId = await createProvider({
      project: setup.projectId,
      baseUrl: 'http://127.0.0.1:1',
    });
    const otherProviderId = await createProvider({
      project: setup.otherProjectId as string,
      baseUrl: otherProject.baseUrl,
    });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: setup.projectId,
        ai_provider_id: ownProviderId,
        name: 'scope-agent',
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;

    // Repointed beneath the write guards: the state a row written by a path
    // that skipped them is in.
    const otherProvider = await db.AiProvider.findOne({
      where: { publicId: otherProviderId },
    });
    await db.Agent.update(
      { aiProviderId: otherProvider!.id },
      { where: { publicId: agentId } }
    );
  });

  afterAll(async () => {
    await otherProject.close();
  });

  test("never generates with the other project's provider", async () => {
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
    expect(otherProject.completions()).toBe(0);
  });
});
