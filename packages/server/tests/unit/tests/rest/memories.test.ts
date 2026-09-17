import { db } from 'src/db';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { setMemorySimilarity } from '../../fixtures/memoryWrites';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * The declared supersede: the caller names the memory a write replaces, and
 * that declaration outranks the similarity bands in both directions.
 *
 * Every test writes into a memory store of its own. The stub embedder answers
 * every input with the same vector, so two memories sharing a store score 1.0
 * against each other until one of them is moved — and a seed landing in another
 * test's store would be absorbed by whatever that test left behind.
 */
describe('POST /api/v1/memories supersedes', () => {
  let adminToken: string;
  let userToken: string;
  let writerToken: string;
  let scopedToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;

  const createStore = async (args: {
    token?: string;
    projectId?: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(args.token ?? userToken)
      .post('/api/v1/memory-stores')
      .send({
        project_id: args.projectId ?? projectId,
        name: `Supersede Store ${crypto.randomUUID()}`,
      });
    return res.body.id as string;
  };

  const write = async (args: {
    token?: string;
    storeId: string;
    content: string;
    supersedes?: string;
  }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .post('/api/v1/memories')
      .send({
        memory_store_id: args.storeId,
        content: args.content,
        ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      });
  };

  /**
   * Seeds one memory and moves it to a chosen cosine from whatever is written
   * next, so a declaration can be aimed at a known band.
   */
  const seedAt = async (args: {
    storeId: string;
    content: string;
    similarity: number;
  }): Promise<string> => {
    const res = await write({ storeId: args.storeId, content: args.content });
    expect(res.body.action).toBe('created');
    await setMemorySimilarity({
      memoryId: res.body.id,
      similarity: args.similarity,
    });
    return res.body.id as string;
  };

  const idsOf = (response: { body: { data: { id: string }[] } }): string[] => {
    return response.body.data.map((entry) => {
      return entry.id;
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'memsup',
      policyActions: [
        'memories:CreateMemoryStore',
        'memories:GetMemoryStore',
        'memories:CreateMemory',
        'memories:GetMemory',
        'memories:ListMemories',
        'memories:UpdateMemory',
        'memories:ListMemoryAssertions',
        'knowledge:SearchKnowledge',
      ],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    // Holds the write grant and nothing that authorizes changing an existing
    // memory — the principal the target-side check exists for.
    writerToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'memsupwriter',
      actions: [
        'memories:GetMemoryStore',
        'memories:CreateMemory',
        'memories:GetMemory',
      ],
    });

    // Same grants as the main user, but reaching one project only — the shape
    // that makes a cross-tenant target a refusal rather than an allowed update.
    scopedToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'memsupscoped',
      actions: [
        'memories:GetMemoryStore',
        'memories:CreateMemory',
        'memories:GetMemory',
        'memories:UpdateMemory',
      ],
    });
  });

  test('retires the declared target far below the supersede threshold', async () => {
    const storeId = await createStore({});
    const target = await seedAt({
      storeId,
      content: 'The office is in Lisbon',
      similarity: 0.2,
    });

    const response = await write({
      storeId,
      content: 'We closed the Lisbon office',
      supersedes: target,
    });

    expect(response.status).toBe(200);
    expect(response.body.action).toBe('superseded');
    expect(response.body.id).not.toBe(target);
    expect(response.body.content).toBe('We closed the Lisbon office');
    expect(response.body.invalidated_at).toBeNull();

    const retired = await db.Memory.findOne({ where: { publicId: target } });
    const replacement = await db.Memory.findOne({
      where: { publicId: response.body.id },
    });
    expect(retired!.invalidatedAt).not.toBeNull();
    expect(retired!.supersededByMemoryId).toBe(replacement!.id);
  });

  test('is not turned into a skip above the duplicate threshold', async () => {
    const storeId = await createStore({});
    const target = await seedAt({
      storeId,
      content: 'The escalation contact is Priya',
      similarity: 0.2,
    });
    const decoy = await seedAt({
      storeId,
      content: 'Refund ceiling is 500 euros',
      similarity: 0.97,
    });

    // Without the declaration this lands on the decoy as a `skipped`.
    const response = await write({
      storeId,
      content: 'Refund ceiling is 500 euro',
      supersedes: target,
    });

    expect(response.status).toBe(200);
    expect(response.body.action).toBe('superseded');
    const retired = await db.Memory.findOne({ where: { publicId: target } });
    const untouched = await db.Memory.findOne({ where: { publicId: decoy } });
    expect(retired!.invalidatedAt).not.toBeNull();
    expect(untouched!.invalidatedAt).toBeNull();
  });

  test('carries the retired memory tags onto the replacement', async () => {
    const storeId = await createStore({});
    const seeded = await authenticatedTestClient(userToken)
      .post('/api/v1/memories')
      .send({
        memory_store_id: storeId,
        content: 'Refunds are approved by Ana',
        tags: { role: 'manager' },
      });
    await setMemorySimilarity({ memoryId: seeded.body.id, similarity: 0.2 });

    const response = await write({
      storeId,
      content: 'Refund approvals moved to finance',
      supersedes: seeded.body.id,
    });

    expect(response.status).toBe(200);
    expect(response.body.tags).toEqual({ role: 'manager' });
  });

  test('the target leaves search, stays readable by id and listable', async () => {
    const storeId = await createStore({});
    const target = await seedAt({
      storeId,
      content: 'The warehouse key is with Mateus',
      similarity: 0.2,
    });
    const replacement = await write({
      storeId,
      content: 'Mateus returned the warehouse key',
      supersedes: target,
    });

    const byId = await authenticatedTestClient(userToken).get(
      `/api/v1/memories/${target}`
    );
    expect(byId.status).toBe(200);
    expect(byId.body.content).toBe('The warehouse key is with Mateus');
    expect(byId.body.superseded_by_memory_id).toBe(replacement.body.id);

    const listed = await authenticatedTestClient(userToken)
      .get('/api/v1/memories')
      .query({ memory_store_id: storeId });
    expect(idsOf(listed)).not.toContain(target);

    const withInvalidated = await authenticatedTestClient(userToken)
      .get('/api/v1/memories')
      .query({ memory_store_id: storeId, include_invalidated: 'true' });
    expect(idsOf(withInvalidated)).toContain(target);

    const search = await authenticatedTestClient(userToken)
      .post('/api/v1/knowledge/search')
      .send({ project_id: projectId, query: 'warehouse key' });
    expect(search.status).toBe(200);
    expect(
      search.body.results.map((result: { memory_id?: string }) => {
        return result.memory_id;
      })
    ).not.toContain(target);
  });

  test('records the declaration on the assertion, with the target similarity', async () => {
    const storeId = await createStore({});
    const target = await seedAt({
      storeId,
      content: 'Invoices are paid on the 10th',
      similarity: 0.2,
    });
    const replacement = await write({
      storeId,
      content: 'Invoices moved to the 25th',
      supersedes: target,
    });

    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/memories/${replacement.body.id}/assertions`
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    const assertion = response.body.data[0];
    expect(assertion.outcome).toBe('superseded');
    expect(assertion.declared).toBe(true);
    expect(assertion.superseded_memory_id).toBe(target);
    // The distance the bands could never have crossed, which is the number the
    // ledger is sampled for.
    expect(assertion.similarity).toBeLessThan(0.9);
  });

  test('a threshold supersede is not reported as declared', async () => {
    const storeId = await createStore({});
    await seedAt({
      storeId,
      content: 'Delivery window is two weeks',
      similarity: 0.92,
    });
    const replacement = await write({
      storeId,
      content: 'Delivery window is four weeks',
    });
    expect(replacement.body.action).toBe('superseded');

    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/memories/${replacement.body.id}/assertions`
    );
    expect(response.body.data[0].declared).toBe(false);
  });

  describe('refusals', () => {
    test('unauthenticated request returns 401', async () => {
      const storeId = await createStore({});
      const response = await testClient.post('/api/v1/memories').send({
        memory_store_id: storeId,
        content: 'No token here',
        supersedes: 'mem_notreached00',
      });
      expect(response.status).toBe(401);
    });

    test('a caller without the write grant returns 403', async () => {
      const storeId = await createStore({});
      const target = await seedAt({
        storeId,
        content: 'Badges expire every 12 months',
        similarity: 0.2,
      });

      const response = await write({
        token: noPermToken,
        storeId,
        content: 'Badges expire every 6 months',
        supersedes: target,
      });

      expect(response.status).toBe(403);
    });

    test('a caller who may write but not update the target returns 403', async () => {
      const storeId = await createStore({});
      const target = await seedAt({
        storeId,
        content: 'The kitchen restocks on Mondays',
        similarity: 0.2,
      });

      const response = await write({
        token: writerToken,
        storeId,
        content: 'The kitchen restocks on Fridays',
        supersedes: target,
      });

      expect(response.status).toBe(403);
      const untouched = await db.Memory.findOne({
        where: { publicId: target },
      });
      expect(untouched!.invalidatedAt).toBeNull();
    });

    test('a supersedes that is not a memory id returns 400', async () => {
      const storeId = await createStore({});

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: storeId,
          content: 'A target that is not an id',
          supersedes: { not: 'an id' },
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a target that does not exist returns 404', async () => {
      const storeId = await createStore({});
      const response = await write({
        storeId,
        content: 'Nothing to replace',
        supersedes: 'mem_doesnotexist00',
      });
      expect(response.status).toBe(404);
    });

    test('a target in another store of the same project returns 400', async () => {
      const storeId = await createStore({});
      const siblingStoreId = await createStore({});
      const target = await seedAt({
        storeId: siblingStoreId,
        content: 'The sibling store holds this fact',
        similarity: 0.2,
      });

      const response = await write({
        storeId,
        content: 'A write into the other store',
        supersedes: target,
      });

      expect(response.status).toBe(400);
      const untouched = await db.Memory.findOne({
        where: { publicId: target },
      });
      expect(untouched!.invalidatedAt).toBeNull();
    });

    test('a target outside the caller project returns 403', async () => {
      const storeId = await createStore({});
      const foreignStoreId = await createStore({
        token: adminToken,
        projectId: otherProjectId,
      });
      const foreign = await write({
        token: adminToken,
        storeId: foreignStoreId,
        content: 'A fact owned by another project',
      });

      const response = await write({
        token: scopedToken,
        storeId,
        content: 'Reaching across the tenant boundary',
        supersedes: foreign.body.id,
      });

      expect(response.status).toBe(403);
      const untouched = await db.Memory.findOne({
        where: { publicId: foreign.body.id },
      });
      expect(untouched!.invalidatedAt).toBeNull();
    });

    test('a target already superseded returns 400', async () => {
      const storeId = await createStore({});
      const target = await seedAt({
        storeId,
        content: 'The server room is on floor 2',
        similarity: 0.2,
      });
      await write({
        storeId,
        content: 'The server room moved to floor 5',
        supersedes: target,
      });

      const response = await write({
        storeId,
        content: 'The server room moved again',
        supersedes: target,
      });

      expect(response.status).toBe(400);
    });
  });
});
