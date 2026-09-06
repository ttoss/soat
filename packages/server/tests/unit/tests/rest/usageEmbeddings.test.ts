import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

// Every embedding the server makes reaches the provider through one function, so
// these assertions drive the entry points that reach it and read the meter back:
// the stateless endpoint, document ingestion, a memory write, and a knowledge
// search (#1208). The stub embedding provider reports one token per word, and
// the rate comes from `EMBEDDING_INPUT_1M_TOKEN_PRICE_USD` rather than the price
// book (#1213).

type MeterRow = {
  meter_type: string;
  source: string | null;
  provider: string;
  model: string;
  generation_id: string | null;
  ai_provider_id: string | null;
  cost_usd: number | null;
  components: Array<{
    component: string;
    quantity: number;
    unit: string;
    billable: boolean;
  }>;
};

describe('Usage — embedding metering', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let noPermToken: string;

  const EMBEDDING_MODEL = 'text-embedding-3-small';
  // USD per million input tokens, as the deployment states it, and the per-token
  // figure it converts to.
  const RATE_PER_1M = '0.02';
  const UNIT_PRICE = 0.00000002;
  // Deliberately different, and deliberately never applied: an embedding is
  // priced from configuration, so a price-book row naming its model is ignored.
  const IGNORED_PRICE_BOOK_UNIT_PRICE = 0.000002;

  const readEmbeddingMeters = async (): Promise<MeterRow[]> => {
    // The route scopes to the caller's own projects — there is no `project_id`
    // filter — and this user can read exactly the one project.
    const res = await authenticatedTestClient(userToken).get(
      '/api/v1/usage/meters?source=embedding'
    );
    expect(res.status).toBe(200);
    return res.body.data as MeterRow[];
  };

  // Ingestion embeds chunk by chunk behind the response, so poll the meter
  // rather than sleeping.
  const waitForMeters = async (expected: number): Promise<MeterRow[]> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await readEmbeddingMeters();
      if (rows.length >= expected) return rows;
      await new Promise((resolve) => {
        return setImmediate(resolve);
      });
    }
    throw new Error(`timed out waiting for ${expected} embedding meter rows`);
  };

  const quantityOf = (row: MeterRow, component: string): number => {
    const found = row.components.find((c) => {
      return c.component === component;
    });
    return Number(found?.quantity ?? -1);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'usageembeddings',
      policyActions: [
        'documents:CreateDocument',
        'embeddings:CreateEmbeddings',
        'knowledge:SearchKnowledge',
        'memories:CreateMemory',
        'memories:CreateMemoryEntry',
        'usage:ListUsageMeters',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken!;

    const priceRes = await authenticatedTestClient(adminToken)
      .put('/api/v1/usage/prices')
      .send({
        prices: [
          {
            provider: 'openai',
            model: EMBEDDING_MODEL,
            component: 'input_tokens',
            unit: 'token',
            unit_price: IGNORED_PRICE_BOOK_UNIT_PRICE,
            effective_from: '2020-01-01T00:00:00.000Z',
          },
        ],
      });
    expect(priceRes.status).toBe(200);

    process.env.EMBEDDING_INPUT_1M_TOKEN_PRICE_USD = RATE_PER_1M;
  });

  afterAll(() => {
    delete process.env.EMBEDDING_INPUT_1M_TOKEN_PRICE_USD;
  });

  test('POST /embeddings meters the call against the named project', async () => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/embeddings')
      .send({ project_id: projectId, input: 'one two three four' });
    expect(res.status).toBe(200);
    expect(res.body.embedding).toHaveLength(1024);

    const rows = await waitForMeters(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].meter_type).toBe('llm_tokens');
    expect(rows[0].source).toBe('embedding');
    expect(rows[0].provider).toBe('openai');
    expect(rows[0].model).toBe(EMBEDDING_MODEL);
    // The embedding stack is env-configured, so no AiProvider row backs it and
    // no Generation record precedes it.
    expect(rows[0].ai_provider_id).toBeNull();
    expect(rows[0].generation_id).toBeNull();
    expect(rows[0].components).toHaveLength(1);
    expect(quantityOf(rows[0], 'input_tokens')).toBe(4);
    // From the deployment rate, not the price-book row above — that one would
    // make this 0.000008.
    expect(rows[0].cost_usd).toBeCloseTo(4 * UNIT_PRICE, 12);
  });

  test('a call naming no project is not metered', async () => {
    const before = await readEmbeddingMeters();

    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/embeddings')
      .send({ input: 'unattributed words here' });
    expect(res.status).toBe(200);

    const after = await readEmbeddingMeters();
    expect(after).toHaveLength(before.length);
  });

  test('an explicit project the caller cannot write to is refused, not billed', async () => {
    const before = await readEmbeddingMeters();

    const res = await authenticatedTestClient(noPermToken)
      .post('/api/v1/embeddings')
      .send({ project_id: projectId, input: 'not mine' });
    expect(res.status).toBe(403);

    const after = await readEmbeddingMeters();
    expect(after).toHaveLength(before.length);
  });

  test("the same caller without a project_id is still served — the route's authorization is unchanged", async () => {
    const res = await authenticatedTestClient(noPermToken)
      .post('/api/v1/embeddings')
      .send({ input: 'still allowed' });
    expect(res.status).toBe(200);
    expect(res.body.embedding).toHaveLength(1024);
  });

  test('unauthenticated request returns 401', async () => {
    const res = await testClient
      .post('/api/v1/embeddings')
      .send({ project_id: projectId, input: 'hello' });
    expect(res.status).toBe(401);
  });

  test('document ingestion meters one event per embedded chunk', async () => {
    const before = await readEmbeddingMeters();

    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: 'alpha beta gamma delta epsilon zeta',
        chunk_strategy: 'size',
        chunk_size: 12,
        chunk_overlap: 0,
        path: '/usage-embeddings/doc.txt',
      });
    expect(res.status).toBe(201);

    const rows = await waitForMeters(before.length + 3);
    const added = rows.length - before.length;
    expect(added).toBeGreaterThanOrEqual(3);
    const chunkRows = rows.slice(0, added);
    for (const row of chunkRows) {
      expect(row.source).toBe('embedding');
      expect(quantityOf(row, 'input_tokens')).toBeGreaterThan(0);
    }
  });

  test('a memory entry write meters its embedding', async () => {
    const memoryRes = await authenticatedTestClient(userToken)
      .post('/api/v1/memories')
      .send({ project_id: projectId, name: 'usage-embeddings-memory' });
    expect(memoryRes.status).toBe(201);

    const before = await readEmbeddingMeters();

    const entryRes = await authenticatedTestClient(userToken)
      .post('/api/v1/memory-entries')
      .send({
        memory_id: memoryRes.body.id,
        content: 'the customer prefers email',
      });
    expect(entryRes.status).toBe(201);

    const rows = await waitForMeters(before.length + 1);
    expect(quantityOf(rows[0], 'input_tokens')).toBe(4);
  });

  test('a knowledge search meters the query embedding', async () => {
    const before = await readEmbeddingMeters();

    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/knowledge/search')
      .send({ project_id: projectId, query: 'alpha beta' });
    expect(res.status).toBe(200);

    const rows = await waitForMeters(before.length + 1);
    expect(rows[0].source).toBe('embedding');
    expect(quantityOf(rows[0], 'input_tokens')).toBe(2);
  });
});
