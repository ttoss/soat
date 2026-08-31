import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Chains are read-only: there is no create endpoint, because a chain is written
 * by the continuation path when a generation declares an initiator. The rows
 * here are seeded directly for the same reason `rest/exceptions.test.ts` seeds
 * through `fileException` — the producer has no request behind it. The producer
 * *behavior* (when a row appears, and what its status becomes) is driven
 * end-to-end in `lib/generationChain.test.ts`.
 */
describe('Chains', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  /** Bound to `projectId`, so it can see exactly one project's chains. */
  let scopedKey: string;
  let projectId: string;
  let otherProjectId: string;
  let activeChainId: string;
  let exhaustedChainId: string;
  let otherProjectChainId: string;

  const seedChain = async (args: {
    projectPublicId: string;
    agentId?: string | null;
    rootGenerationId: string;
    status: string;
    generationCount: number;
  }): Promise<string> => {
    const project = await db.Project.findOne({
      where: { publicId: args.projectPublicId },
    });
    const chain = await db.GenerationChain.create({
      projectId: project!.id as number,
      agentId: args.agentId ?? null,
      rootGenerationId: args.rootGenerationId,
      status: args.status,
      generationCount: args.generationCount,
      lastGenerationAt: new Date(),
    });
    return chain.publicId;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'chains',
      policyActions: [
        'chains:ListChains',
        'chains:GetChain',
        'api-keys:CreateApiKey',
      ],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    activeChainId = await seedChain({
      projectPublicId: projectId,
      agentId: 'agent_chainsactive00000',
      rootGenerationId: 'gen_chainsactive00000',
      status: 'active',
      generationCount: 3,
    });
    exhaustedChainId = await seedChain({
      projectPublicId: projectId,
      agentId: 'agent_chainsspent000000',
      rootGenerationId: 'gen_chainsspent000000',
      status: 'budget_exhausted',
      generationCount: 100,
    });
    otherProjectChainId = await seedChain({
      projectPublicId: otherProjectId,
      rootGenerationId: 'gen_chainsother000000',
      status: 'concluded',
      generationCount: 2,
    });

    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectId,
        policy_ids: [setup.policyId],
        name: 'chains scoped key',
      });
    scopedKey = keyRes.body.key;
  });

  describe('GET /api/v1/chains', () => {
    test('lists the chains in a project', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/chains?project_id=${projectId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      const ids = res.body.data.map((chain: { id: string }) => {
        return chain.id;
      });
      expect(ids).toContain(activeChainId);
      expect(ids).toContain(exhaustedChainId);
      // The chain's key is the root generation, which stays internal — a caller
      // walks chain → generations through `GET /generations?chain_id=`.
      expect(res.body.data[0].root_generation_id).toBeUndefined();
    });

    test('the listed shape carries the chain state', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/chains?project_id=${projectId}&status=budget_exhausted`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({
        id: exhaustedChainId,
        project_id: projectId,
        agent_id: 'agent_chainsspent000000',
        status: 'budget_exhausted',
        generation_count: 100,
      });
      expect(res.body.data[0].last_generation_at).toBeDefined();
    });

    test('filters by agent_id', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/chains?project_id=${projectId}&agent_id=agent_chainsactive00000`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].id).toBe(activeChainId);
    });

    test('another project chain is not listed', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/chains?project_id=${projectId}`
      );

      const ids = res.body.data.map((chain: { id: string }) => {
        return chain.id;
      });
      expect(ids).not.toContain(otherProjectChainId);
    });

    test('an unscoped list is a page, not every project', async () => {
      // Same contract as `list-exceptions`: without `project_id` an
      // unrestricted caller resolves to no project filter, which this route
      // reads as an empty scope rather than as "all projects". Chains are
      // project-owned, so a cross-project firehose is the wrong default.
      const res =
        await authenticatedTestClient(adminToken).get('/api/v1/chains');

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.data).toEqual([]);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/chains');
      expect(res.status).toBe(401);
    });

    test('a user without the action returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/chains?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/chains/{chain_id}', () => {
    test('returns a single chain', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/chains/${activeChainId}`
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: activeChainId,
        project_id: projectId,
        status: 'active',
        generation_count: 3,
      });
    });

    test('a chain outside the credential project is not found', async () => {
      // A project-scoped key resolves to exactly one project, so the lookup is
      // scoped and a chain elsewhere reads as missing rather than as another
      // project's row leaking through an id-only get.
      const own = await authenticatedTestClient(scopedKey).get(
        `/api/v1/chains/${activeChainId}`
      );
      expect(own.status).toBe(200);

      const res = await authenticatedTestClient(scopedKey).get(
        `/api/v1/chains/${otherProjectChainId}`
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CHAIN_NOT_FOUND');
    });

    test('an unknown chain returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/chains/chain_doesnotexist0000'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CHAIN_NOT_FOUND');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(`/api/v1/chains/${activeChainId}`);
      expect(res.status).toBe(401);
    });

    test('a user without the action returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/chains/${activeChainId}`
      );
      expect(res.status).toBe(403);
    });
  });
});
