import { db } from 'src/db';
import { EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV } from 'src/lib/embeddingPrice';
import { recordEmbeddingUsage } from 'src/lib/usageEmbeddingRecording';

// The embedding stack is env-configured rather than backed by an AiProvider
// row, so these pin the three things that follow from that: the event bills
// against the provider *slug* with no provider instance, an embedding call has
// an input dimension only, and its rate comes from the deployment variable
// rather than from the price book.
describe('recordEmbeddingUsage', () => {
  let projectId: number;

  const PROVIDER = 'openai';
  const MODEL = 'text-embedding-3-small';

  const setRate = (value: string | undefined) => {
    if (value === undefined) {
      delete process.env[EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV];
    } else {
      process.env[EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV] = value;
    }
  };

  const componentsOf = async (eventId: number) => {
    return db.UsageComponent.findAll({ where: { usageEventId: eventId } });
  };

  const eventsForProject = async () => {
    return db.UsageEvent.findAll({
      where: { projectId, meterType: 'llm_tokens' },
      order: [['id', 'ASC']],
    });
  };

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'Embedding Usage' });
    projectId = project.id;

    // Deliberately present and deliberately never read: a deployment that
    // seeded this row before the rate moved to configuration must not have its
    // embeddings priced from two places.
    await db.PriceBook.create({
      aiProviderId: null,
      projectId: null,
      meterType: 'llm_tokens',
      provider: PROVIDER,
      model: MODEL,
      component: 'input_tokens',
      unit: 'token',
      unitPrice: 0.000002,
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    });
  });

  afterEach(() => {
    setRate(undefined);
  });

  test('writes one event with a single input_tokens component, priced at the deployment rate', async () => {
    setRate('0.02');

    await recordEmbeddingUsage({
      projectId,
      provider: PROVIDER,
      model: MODEL,
      tokens: 1500,
    });

    const events = await eventsForProject();
    expect(events).toHaveLength(1);
    expect(events[0].provider).toBe(PROVIDER);
    expect(events[0].model).toBe(MODEL);
    expect(events[0].source).toBe('embedding');
    expect(events[0].aiProviderId).toBeNull();
    expect(events[0].generationId).toBeNull();
    // 1500 tokens × $0.02/1M — not the 0.003 the price-book row would give.
    expect(Number(events[0].costUsd)).toBeCloseTo(0.00003, 10);

    const components = await componentsOf(events[0].id as number);
    expect(components).toHaveLength(1);
    expect(components[0].component).toBe('input_tokens');
    expect(Number(components[0].quantity)).toBe(1500);
    expect(components[0].unit).toBe('token');
    expect(components[0].billable).toBe(true);
    expect(Number(components[0].unitPrice)).toBeCloseTo(0.00000002, 12);
    // The rate is configuration, so no price-book row explains this cost.
    expect(components[0].priceId).toBeNull();
  });

  test('an unset rate records zero rather than null — the deployment states no cost', async () => {
    setRate(undefined);

    await recordEmbeddingUsage({
      projectId,
      provider: PROVIDER,
      model: 'unset-rate-model',
      tokens: 42,
    });

    const event = (await eventsForProject()).find((candidate) => {
      return candidate.model === 'unset-rate-model';
    });
    expect(event).toBeDefined();
    expect(event!.costUsd).not.toBeNull();
    expect(Number(event!.costUsd)).toBe(0);

    const components = await componentsOf(event!.id as number);
    expect(Number(components[0].quantity)).toBe(42);
    expect(Number(components[0].costUsd)).toBe(0);
  });

  test('a model the price book knows is still priced at the deployment rate', async () => {
    setRate('0');

    await recordEmbeddingUsage({
      projectId,
      provider: PROVIDER,
      model: MODEL,
      tokens: 1000,
    });

    const events = await eventsForProject();
    const latest = events[events.length - 1];
    // The price-book row would make this 0.002.
    expect(Number(latest.costUsd)).toBe(0);
  });

  test('an unparseable rate is swallowed like any other metering failure', async () => {
    setRate('free');
    const before = await eventsForProject();

    await expect(
      recordEmbeddingUsage({
        projectId,
        provider: PROVIDER,
        model: MODEL,
        tokens: 5,
      })
    ).resolves.toBeUndefined();

    expect(await eventsForProject()).toHaveLength(before.length);
  });

  test('a second call is a second event — an embedding call has no replay identity', async () => {
    setRate('0.02');

    await recordEmbeddingUsage({
      projectId,
      provider: PROVIDER,
      model: MODEL,
      tokens: 10,
    });
    await recordEmbeddingUsage({
      projectId,
      provider: PROVIDER,
      model: MODEL,
      tokens: 10,
    });

    const events = await eventsForProject();
    const keys = events.map((event) => {
      return event.idempotencyKey;
    });
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[keys.length - 1]).toMatch(/^embedding:/);
  });

  test('a project that does not exist is swallowed, not thrown', async () => {
    const before = await eventsForProject();

    // The project FK is what fails here — a real database refusal rather than a
    // stubbed one, driving the contract that metering never fails the embedding
    // call it measures.
    await expect(
      recordEmbeddingUsage({
        projectId: 2_147_483_600,
        provider: PROVIDER,
        model: MODEL,
        tokens: 5,
      })
    ).resolves.toBeUndefined();

    expect(await eventsForProject()).toHaveLength(before.length);
  });
});
