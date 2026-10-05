import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  createQuotaRow,
  freshProjectAndAgent,
  seedUsageEvent,
} from '../../fixtures/quotaSeed';
import {
  startStubChatProvider,
  type StubChatProvider,
} from '../../fixtures/stubChatProvider';
import { authenticatedTestClient } from '../../testClient';

/**
 * What a `cost_usd` cap does when the window it aggregates was not fully
 * priced. `SUM(cost_usd)` ignores nulls, so an unpriced event contributes 0 and
 * the cap measures less than it caps — a *blackout* (nothing priced) makes it
 * unenforceable outright, a partly-priced window makes it enforce a fraction of
 * real spend. The `quota_unpriced` exception files from the first unpriced row
 * either way; the refusal needs a blackout of UNPRICED_BLACKOUT_MIN_EVENTS, so
 * a window's first event landing on the one unpriced model of a mostly-priced
 * project cannot stop it at every window boundary.
 *
 * Usage rows are seeded directly; there is no create API for a metered event.
 * The agents' provider is a local stub whose model carries a zero price, so a
 * generation the check admits meters a priced event that neither moves a cost
 * total nor deepens a blackout.
 */

const ADMIT_MODEL = 'unpriced-admit-model';

type Fresh = Awaited<ReturnType<typeof freshProjectAndAgent>>;

type ExceptionItem = {
  severity: string;
  title: string;
  occurrence_count: number;
  detail: Record<string, unknown>;
};

describe('POST /api/v1/agents/:agent_id/generate — unpriced cost_usd quotas', () => {
  let adminToken: string;
  let stub: StubChatProvider;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'unpricedquota',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    stub = await startStubChatProvider();

    const priceRes = await authenticatedTestClient(adminToken)
      .put('/api/v1/usage/prices')
      .send({
        prices: ['input_tokens', 'output_tokens'].map((component) => {
          return {
            provider: 'ollama',
            model: ADMIT_MODEL,
            component,
            unit: 'token',
            unit_price: 0,
            effective_from: '2020-01-01T00:00:00.000Z',
          };
        }),
      });
    expect(priceRes.status).toBe(200);
  });

  afterAll(async () => {
    await stub.close();
  });

  const fresh = (name: string): Promise<Fresh> => {
    return freshProjectAndAgent({
      adminToken,
      name,
      baseUrl: stub.baseUrl,
      defaultModel: ADMIT_MODEL,
    });
  };

  const createCostQuota = async (
    ctx: Fresh,
    body: Record<string, unknown> = {}
  ): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/quotas')
      .send({
        project_id: ctx.projectPublicId,
        scope: 'project',
        metric: 'cost_usd',
        window: 'calendar_month',
        limit: 5,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generate = (ctx: Fresh) => {
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${ctx.agentPublicId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
  };

  const expectAdmitted = (res: {
    status: number;
    body: { status?: string };
  }) => {
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  };

  const expectUnenforceable = (res: {
    status: number;
    body: { error?: { code: string } };
  }) => {
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('QUOTA_UNENFORCEABLE');
  };

  const unpricedExceptions = async (ctx: Fresh): Promise<ExceptionItem[]> => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/exceptions?project_id=${ctx.projectPublicId}&kind=quota_unpriced`
    );
    expect(res.status).toBe(200);
    return res.body.data;
  };

  const seedUnpricedEvents = async (ctx: Fresh, count: number) => {
    for (let i = 0; i < count; i += 1) {
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100, output: 50 },
        costUsd: null,
      });
    }
  };

  // What an operator must price next: `cached_tokens` measured 0 and
  // `reasoning_tokens` is not billable, so pricing either changes nothing.
  const SEEDED_UNPRICED_ROWS = [
    { provider: 'ollama', model: 'stub-model', component: 'input_tokens' },
    { provider: 'ollama', model: 'stub-model', component: 'output_tokens' },
  ];

  describe('a blackout', () => {
    test('refuses with 409 naming the rows to price, and files an exception', async () => {
      const ctx = await fresh('unpriced-file');
      await seedUnpricedEvents(ctx, 3);
      const quotaId = await createCostQuota(ctx);

      const res = await generate(ctx);

      // The window resetting changes nothing here, so the Retry-After a 429
      // carries would be a lie: configuring pricing is the fix.
      expectUnenforceable(res);
      expect(res.body.error.meta).toEqual({
        quota_id: quotaId,
        metric: 'cost_usd',
        limit: 5,
        window: 'calendar_month',
        unpriced_rows: SEEDED_UNPRICED_ROWS,
      });

      const items = await unpricedExceptions(ctx);
      expect(items).toHaveLength(1);
      expect(items[0].severity).toBe('warning');
      expect(items[0].title).toContain(quotaId);
      expect(items[0].detail).toMatchObject({
        quota_id: quotaId,
        metric: 'cost_usd',
        limit: 5,
        unpriced_event_count: 3,
      });
    });

    test('a quota stored with no on_unpriced posture blocks', async () => {
      const ctx = await fresh('unpriced-legacy');
      await seedUnpricedEvents(ctx, 3);
      // Written beneath the API, which always stores a posture: the row a
      // quota created before the column carries.
      const quota = await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'project',
        metric: 'cost_usd',
        limit: 5,
      });

      const res = await generate(ctx);

      expectUnenforceable(res);
      expect(res.body.error.meta.quota_id).toBe(quota.publicId);
    });

    test('below the threshold admits, but still files', async () => {
      const ctx = await fresh('unpriced-below');
      await seedUnpricedEvents(ctx, 2);
      await createCostQuota(ctx);

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(1);
    });

    test('on_unpriced "allow" never blocks, and still files', async () => {
      const ctx = await fresh('unpriced-allow');
      await seedUnpricedEvents(ctx, 5);
      await createCostQuota(ctx, { on_unpriced: 'allow' });

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(1);
    });

    test('a monitor quota never blocks, and still files', async () => {
      const ctx = await fresh('unpriced-monitor');
      await seedUnpricedEvents(ctx, 3);
      await createCostQuota(ctx, { mode: 'monitor' });

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(1);
    });

    test('a quota scoped to the AI meter is refused all the same', async () => {
      const ctx = await fresh('unpriced-meter-ai');
      await seedUnpricedEvents(ctx, 3);
      await createCostQuota(ctx, { meter_type: 'llm_tokens' });

      expectUnenforceable(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(1);
    });

    /**
     * A cap scoped to a platform meter answers for that meter alone, so an AI
     * blackout beside it is not its blackout: refusing would stop generation
     * over a gap the cap does not measure.
     */
    test('does not refuse a quota scoped to a platform meter', async () => {
      const ctx = await fresh('unpriced-meter-scoped');
      await seedUnpricedEvents(ctx, 3);
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        meterType: 'storage',
        costUsd: '1.00',
      });
      await createCostQuota(ctx, { meter_type: 'storage' });

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(0);
    });
  });

  // A platform meter is priced by the operator, and an embedding against the
  // deployment's own rate: neither is a price row a tenant can create, so both
  // are read out of the verdict in either direction.
  describe('what the verdict reads', () => {
    test('a window of only unpriced platform events is not a blackout', async () => {
      const ctx = await fresh('unpriced-compute');
      for (let i = 0; i < 4; i += 1) {
        await seedUsageEvent({
          projectInternalId: ctx.projectInternalId,
          meterType: 'compute_execution',
          costUsd: null,
        });
      }
      await createCostQuota(ctx);

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(0);
    });

    test('a priced platform event does not mask an AI blackout', async () => {
      const ctx = await fresh('unpriced-masked');
      await seedUnpricedEvents(ctx, 3);
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        meterType: 'compute_execution',
        costUsd: '0.01',
      });
      await createCostQuota(ctx);

      expectUnenforceable(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(1);
    });

    test('a window of only embedding events is not a blackout', async () => {
      const ctx = await fresh('unpriced-embedding');
      for (let i = 0; i < 4; i += 1) {
        await seedUsageEvent({
          projectInternalId: ctx.projectInternalId,
          source: 'embedding',
          costUsd: '0',
        });
      }
      await createCostQuota(ctx);

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(0);
    });

    // An unset embedding rate meters at 0, a *priced* event: counted in the
    // verdict it would wave through every unpriced generation beside it.
    test('an embedding priced at zero does not clear a blackout', async () => {
      const ctx = await fresh('unpriced-embedmask');
      await seedUnpricedEvents(ctx, 3);
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        source: 'embedding',
        costUsd: '0',
      });
      await createCostQuota(ctx);

      expectUnenforceable(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(1);
    });

    test('an embedding is never named as a row to price', async () => {
      const ctx = await fresh('unpriced-rows-embed');
      await seedUnpricedEvents(ctx, 3);
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        source: 'embedding',
        provider: 'openai',
        model: 'text-embedding-3-small',
        tokens: { input: 100 },
        costUsd: null,
      });
      await createCostQuota(ctx);

      const res = await generate(ctx);

      expectUnenforceable(res);
      expect(res.body.error.meta.unpriced_rows).toEqual(SEEDED_UNPRICED_ROWS);
    });

    test('an unpriced embedding beside priced usage files nothing', async () => {
      const ctx = await fresh('unpriced-part-embed');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100, output: 50 },
        costUsd: '1.00',
      });
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        source: 'embedding',
        provider: 'openai',
        model: 'text-embedding-3-small',
        tokens: { input: 100 },
        costUsd: null,
      });
      await createCostQuota(ctx);

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(0);
    });

    test('an unpriced platform meter beside priced usage files nothing', async () => {
      const ctx = await fresh('unpriced-part-compute');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100, output: 50 },
        costUsd: '1.00',
      });
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        meterType: 'compute_execution',
        tokens: { input: 100 },
        costUsd: null,
      });
      await createCostQuota(ctx);

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(0);
    });
  });

  /**
   * Model A carries a price row, model B does not: `SUM(cost_usd)` reads A's
   * spend alone. The priced total is real, if incomplete, so the window is
   * still measured against the limit — refusing on a ratio would make a cost
   * cap unrecoverable — and the exception is the whole of the signal.
   */
  describe('a partly-priced window', () => {
    test('files an exception naming the unpriced model, without refusing', async () => {
      const ctx = await fresh('unpriced-partial');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100, output: 50 },
        model: 'priced-model',
        costUsd: '1.00',
      });
      await seedUnpricedEvents(ctx, 3);
      await createCostQuota(ctx);

      expectAdmitted(await generate(ctx));

      const items = await unpricedExceptions(ctx);
      expect(items).toHaveLength(1);
      expect(items[0].detail).toMatchObject({
        unpriced_event_count: 3,
        metered_event_count: 4,
        unpriced_rows: SEEDED_UNPRICED_ROWS,
      });
    });

    test('is still refused on reaching the limit', async () => {
      const ctx = await fresh('unpriced-partial-cap');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100, output: 50 },
        model: 'priced-model',
        costUsd: '5.00',
      });
      await seedUnpricedEvents(ctx, 1);
      const quotaId = await createCostQuota(ctx);

      const res = await generate(ctx);

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(res.body.error.meta.quota_id).toBe(quotaId);
      expect(await unpricedExceptions(ctx)).toHaveLength(1);
    });

    /**
     * An event with an input-token price and no output-token price counts as
     * priced at the event level; reading components is what sees the gap.
     */
    test('names the component a priced event left unpriced', async () => {
      const ctx = await fresh('unpriced-component');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100, output: 50 },
        costUsd: '0.01',
        unpricedComponents: ['output'],
      });
      await createCostQuota(ctx);

      expectAdmitted(await generate(ctx));

      const items = await unpricedExceptions(ctx);
      expect(items).toHaveLength(1);
      expect(items[0].detail).toMatchObject({
        unpriced_event_count: 0,
        unpriced_rows: [
          {
            provider: 'ollama',
            model: 'stub-model',
            component: 'output_tokens',
          },
        ],
      });
    });
  });

  describe('files nothing', () => {
    test('when every event is priced in full', async () => {
      const ctx = await fresh('unpriced-full');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100, output: 50, reasoning: 20 },
        costUsd: '1.00',
      });
      await createCostQuota(ctx);

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(0);
    });

    // A zero aggregate with nothing metered is legitimately zero.
    test('when the window metered nothing', async () => {
      const ctx = await fresh('unpriced-empty');
      await createCostQuota(ctx);

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(0);
    });

    test('for a tokens quota, which does not depend on pricing', async () => {
      const ctx = await fresh('unpriced-tokens');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 10, output: 5 },
        costUsd: null,
      });
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/quotas')
        .send({
          project_id: ctx.projectPublicId,
          scope: 'project',
          metric: 'tokens',
          window: 'calendar_month',
          limit: 1000,
        });
      expect(res.status).toBe(201);

      expectAdmitted(await generate(ctx));
      expect(await unpricedExceptions(ctx)).toHaveLength(0);
    });
  });

  // One triage item, not three: the occurrence count is what conveys how many
  // generations ran while the cap was not measuring.
  test('folds repeat checks into one item with an occurrence count', async () => {
    const ctx = await fresh('unpriced-dedup');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      costUsd: null,
    });
    await createCostQuota(ctx);

    for (let i = 0; i < 3; i += 1) {
      expectAdmitted(await generate(ctx));
    }

    const items = await unpricedExceptions(ctx);
    expect(items).toHaveLength(1);
    expect(items[0].occurrence_count).toBe(3);
  });
});
