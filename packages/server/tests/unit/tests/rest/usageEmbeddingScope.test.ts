import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

// The provider bills every embedding, so every embedding is billed to a
// project: the one named, else the one the credential is bound to, else — for
// a search spanning several — the first, by public id, the caller may spend
// embeddings on. A call with none is refused.

type MeterRow = { project_id: string; source: string | null };

describe('Usage — the project an embedding is billed to', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;

  const readEmbeddingMeters = async (): Promise<MeterRow[]> => {
    const res = await authenticatedTestClient(adminToken).get(
      '/api/v1/usage/events?source=embedding&limit=100'
    );
    expect(res.status).toBe(200);
    return res.body.data as MeterRow[];
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'embeddingscope',
      policyActions: [
        'embeddings:CreateEmbeddings',
        'knowledge:SearchKnowledge',
        'usage:ListEvents',
      ],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
  });

  describe('POST /api/v1/embeddings', () => {
    test.each(['user', 'admin'] as const)(
      'a %s naming no project, on a credential bound to none, is refused',
      async (who) => {
        const before = await readEmbeddingMeters();

        const res = await authenticatedTestClient(
          who === 'user' ? userToken : adminToken
        )
          .post('/api/v1/embeddings')
          .send({ input: 'unattributed words here' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(await readEmbeddingMeters()).toHaveLength(before.length);
      }
    );

    test('a project-bound key naming no project bills its project', async () => {
      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Bound key', project_id: otherProjectId });
      expect(keyRes.status).toBe(201);
      const before = await readEmbeddingMeters();

      const res = await authenticatedTestClient(keyRes.body.key)
        .post('/api/v1/embeddings')
        .send({ input: 'bound words' });

      expect(res.status).toBe(200);
      const after = await readEmbeddingMeters();
      expect(after).toHaveLength(before.length + 1);
      expect(after[0].project_id).toBe(otherProjectId);
    });
  });

  describe('POST /api/v1/knowledge/search', () => {
    // Search everywhere; spend embeddings only where `spendOn` names.
    const userWhoMaySpendOn = async (args: {
      username: string;
      spendOn: string[];
    }): Promise<string> => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: args.username, password: `${args.username}pass` });
      const statement: object[] = [
        { effect: 'Allow', action: ['knowledge:SearchKnowledge'] },
      ];
      if (args.spendOn.length > 0) {
        statement.push({
          effect: 'Allow',
          action: ['embeddings:CreateEmbeddings'],
          resource: args.spendOn.map((id) => {
            return `srn:${id}:*:*`;
          }),
        });
      }
      const policy = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({ document: { statement } });
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${created.body.id}/policies`)
        .send({ policy_ids: [policy.body.id] });
      return loginAs(args.username, `${args.username}pass`);
    };

    test('a search spanning several projects bills the first, by public id', async () => {
      const before = await readEmbeddingMeters();

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ query: 'alpha beta' });

      expect(res.status).toBe(200);
      const after = await readEmbeddingMeters();
      expect(after).toHaveLength(before.length + 1);
      expect(after[0].project_id).toBe([projectId, otherProjectId].sort()[0]);
    });

    test('bills the one project the caller may spend embeddings on', async () => {
      const spendOn = [projectId, otherProjectId].sort()[1];
      const token = await userWhoMaySpendOn({
        username: 'embeddingscopespender',
        spendOn: [spendOn],
      });
      const before = await readEmbeddingMeters();

      const res = await authenticatedTestClient(token)
        .post('/api/v1/knowledge/search')
        .send({ query: 'alpha beta' });

      expect(res.status).toBe(200);
      const after = await readEmbeddingMeters();
      expect(after).toHaveLength(before.length + 1);
      expect(after[0].project_id).toBe(spendOn);
    });

    test('a caller who may spend embeddings nowhere in scope is refused', async () => {
      const token = await userWhoMaySpendOn({
        username: 'embeddingscopereader',
        spendOn: [],
      });
      const before = await readEmbeddingMeters();

      const res = await authenticatedTestClient(token)
        .post('/api/v1/knowledge/search')
        .send({ query: 'alpha beta' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(await readEmbeddingMeters()).toHaveLength(before.length);
    });

    test('a search with no query embeds nothing and needs no spend', async () => {
      const token = await userWhoMaySpendOn({
        username: 'embeddingscopetagger',
        spendOn: [],
      });

      const res = await authenticatedTestClient(token)
        .post('/api/v1/knowledge/search')
        .send({ tags: { topic: 'none' } });

      expect(res.status).toBe(200);
    });
  });
});
