import { db } from 'src/db';
import { recordEmbeddingUsage } from 'src/lib/usageEmbeddingRecording';

// The embedding stack is env-configured rather than backed by an AiProvider row,
// so these assertions pin the two things that follow from that: the event bills
// against the provider *slug* with no provider instance, and an embedding call
// has an input dimension only.
describe('recordEmbeddingUsage', () => {
  let projectId: number;

  const PROVIDER = 'openai';
  const MODEL = 'text-embedding-3-small';

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

  test('writes one priced llm_tokens event with a single input_tokens component', async () => {
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
    expect(Number(events[0].costUsd)).toBeCloseTo(0.003, 10);

    const components = await componentsOf(events[0].id as number);
    expect(components).toHaveLength(1);
    expect(components[0].component).toBe('input_tokens');
    expect(Number(components[0].quantity)).toBe(1500);
    expect(components[0].unit).toBe('token');
    expect(components[0].billable).toBe(true);
  });

  test('a second call is a second event — an embedding call has no replay identity', async () => {
    await recordEmbeddingUsage({
      projectId,
      provider: PROVIDER,
      model: MODEL,
      tokens: 10,
    });

    const events = await eventsForProject();
    expect(events).toHaveLength(2);
    expect(events[0].idempotencyKey).not.toBe(events[1].idempotencyKey);
    expect(events[1].idempotencyKey).toMatch(/^embedding:/);
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

  test('an unpriced model records the quantity with a null cost', async () => {
    await recordEmbeddingUsage({
      projectId,
      provider: PROVIDER,
      model: 'unpriced-embedding-model',
      tokens: 42,
    });

    const events = await eventsForProject();
    const unpriced = events.find((event) => {
      return event.model === 'unpriced-embedding-model';
    });
    expect(unpriced).toBeDefined();
    expect(unpriced!.costUsd).toBeNull();

    const components = await componentsOf(unpriced!.id as number);
    expect(components).toHaveLength(1);
    expect(Number(components[0].quantity)).toBe(42);
    expect(components[0].costUsd).toBeNull();
  });
});
