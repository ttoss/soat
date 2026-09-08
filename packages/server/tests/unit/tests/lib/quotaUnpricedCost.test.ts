import { db } from 'src/db';
import {
  evaluateGenerationQuotas,
  quotaBreachError,
} from 'src/lib/quotaEnforcement';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  createQuotaRow,
  freshProjectAndAgent as freshProjectAndAgentFixture,
  seedUsageEvent,
} from '../../fixtures/quotaSeed';

// What a `cost_usd` cap does when the window it aggregates was not fully
// priced. `SUM(cost_usd)` ignores nulls, so an unpriced event contributes 0 and
// the cap is measuring less than it caps — a *blackout* (nothing priced) makes
// it unenforceable outright, a partly-priced window makes it enforce a fraction
// of real spend. The triage item files from the first unpriced row either way;
// the refusal needs a blackout of at least UNPRICED_BLACKOUT_MIN_EVENTS events,
// so a window's first event landing on the one unpriced model of a
// mostly-priced project cannot stop it at every window boundary.
//
// Usage rows are seeded directly; there is no create API for a metered event.

describe('unpriced cost_usd quotas', () => {
  let adminToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'unpricedquota',
      policyActions: [],
    });
    adminToken = setup.adminToken;
  });

  const freshProjectAndAgent = (name: string) => {
    return freshProjectAndAgentFixture({ adminToken, name });
  };

  const seedUnpricedEvents = async (
    ctx: { projectInternalId: number; agentInternalId: number },
    count: number
  ) => {
    for (let i = 0; i < count; i += 1) {
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100, output: 50 },
        costUsd: null,
      });
    }
  };
  const unpricedExceptions = async (projectInternalId: number) => {
    return db.ExceptionItem.findAll({
      where: { projectId: projectInternalId, kind: 'quota_unpriced' },
    });
  };

  test('blocks and files an exception once a blackout reaches the threshold', async () => {
    const ctx = await freshProjectAndAgent('genquota-unpriced-file');
    await seedUnpricedEvents(ctx, 3);
    // No on_unpriced stored — the row a pre-column deployment left behind —
    // so this also pins that legacy quotas default to blocking.
    const quota = await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    // The aggregate is 0 because nothing is priced, so the limit comparison
    // can never fire — the cap refuses the spend it cannot measure instead.
    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach?.reason).toBe('unpriced_usage');
    expect(breach?.quotaId).toBe(quota.publicId);

    // The triage item is filed alongside the refusal, not instead of it.
    const items = await unpricedExceptions(ctx.projectInternalId);
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('warning');
    expect(items[0].title).toContain(quota.publicId);
    const detail = items[0].detail as Record<string, unknown>;
    expect(detail.quotaId).toBe(quota.publicId);
    expect(detail.metric).toBe('cost_usd');
    expect(detail.limit).toBe(5);
    expect(detail.unpricedEventCount).toBe(3);
  });

  test('does not block below the blackout threshold, but still files', async () => {
    // A fresh window's first metered event can land on the one unpriced
    // model of a mostly-priced project. Ordering noise must not stop the
    // project at every window boundary — the exception is the early signal,
    // the refusal waits for a real blackout.
    const ctx = await freshProjectAndAgent('genquota-unpriced-below');
    await seedUnpricedEvents(ctx, 2);
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();
    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(1);
  });

  test('on_unpriced "allow" never blocks, whatever the blackout size', async () => {
    // The explicit opt-out: the operator chose availability over containment,
    // on the quota itself where the next reader can see it. The exception
    // still files — allow means unblocked, not unwatched.
    const ctx = await freshProjectAndAgent('genquota-unpriced-allow');
    await seedUnpricedEvents(ctx, 5);
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
      onUnpriced: 'allow',
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();
    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(1);
  });

  /**
   * A platform meter is priced by the operator, not by a tenant's provider,
   * so a deployment that prices no compute has not lost the ability to
   * measure AI spend. Counting it also deadlocks the cap: a window holding
   * only unpriced platform events refuses the very generation that would land
   * the first priced AI event, so the blackout could never clear.
   */
  test('a window of only unpriced platform events is not a blackout', async () => {
    const ctx = await freshProjectAndAgent('genquota-unpriced-compute');
    for (let i = 0; i < 4; i += 1) {
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        meterType: 'compute_execution',
        costUsd: null,
      });
    }
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();
    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(0);
  });

  /**
   * The other half of reading the AI meter alone: a priced platform event
   * must not mask a genuine AI blackout, which is what a verdict taken over
   * every meter together would do.
   */
  test('a priced platform event does not mask an unpriced AI blackout', async () => {
    const ctx = await freshProjectAndAgent('genquota-unpriced-masked');
    await seedUnpricedEvents(ctx, 3);
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      meterType: 'compute_execution',
      costUsd: '0.01',
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach?.reason).toBe('unpriced_usage');
    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(1);
  });

  /**
   * An embedding is metered against a rate the tenant does not own and cannot
   * set — `EMBEDDING_INPUT_1M_TOKEN_PRICE_USD` is the deployment's, and no
   * price-book tier reaches a call that carries no provider record. So it is
   * read out of the blackout verdict in both directions: it can neither raise
   * one (#1213, where ingestion alone turned a healthy cap into a 409) nor
   * clear one.
   */
  test('a window of only embedding events is not a blackout', async () => {
    const ctx = await freshProjectAndAgent('genquota-unpriced-embedding');
    for (let i = 0; i < 4; i += 1) {
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        source: 'embedding',
        costUsd: '0',
      });
    }
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();
    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(0);
  });

  test('an embedding priced at zero does not clear a genuine blackout', async () => {
    // An unset embedding rate meters at 0, which is a *priced* event. Counted
    // in the verdict it would report the window as priced and wave through
    // every unpriced generation beside it — the fail-open the cap exists to
    // prevent, now reachable from ordinary ingestion.
    const ctx = await freshProjectAndAgent('genquota-unpriced-embedmask');
    await seedUnpricedEvents(ctx, 3);
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      source: 'embedding',
      costUsd: '0',
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach?.reason).toBe('unpriced_usage');
    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(1);
  });

  test('files nothing when the window has priced events', async () => {
    const ctx = await freshProjectAndAgent('genquota-unpriced-priced');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      costUsd: '1.00',
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });

    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(0);
  });

  test('files nothing when the window has no events at all', async () => {
    // A zero aggregate with nothing metered is legitimately zero, not a
    // pricing gap — filing here would cry wolf on every idle project.
    const ctx = await freshProjectAndAgent('genquota-unpriced-empty');
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });

    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(0);
  });

  test('files nothing for a tokens quota, which does not depend on pricing', async () => {
    const ctx = await freshProjectAndAgent('genquota-unpriced-tokens');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      tokens: { input: 10, output: 5 },
      costUsd: null,
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'tokens',
      limit: 1000,
    });

    await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });

    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(0);
  });

  test('folds repeat evaluations into one item with an occurrence count', async () => {
    const ctx = await freshProjectAndAgent('genquota-unpriced-dedup');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      costUsd: null,
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });
    await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });
    await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });

    // One triage item, not three — the occurrence count is what conveys how
    // many generations ran while the cap was dead.
    const items = await unpricedExceptions(ctx.projectInternalId);
    expect(items).toHaveLength(1);
    expect(items[0].occurrenceCount).toBe(3);
  });

  test('does not block a monitor quota over an unpriced window', async () => {
    // `monitor` means observe, never block — including here. The exception
    // still names the cap, which is the whole of what monitor mode owes.
    const ctx = await freshProjectAndAgent('genquota-unpriced-monitor');
    await seedUnpricedEvents(ctx, 3);
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
      mode: 'monitor',
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();
    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(1);
  });

  test('reports an unpriced refusal as QUOTA_UNENFORCEABLE, not a 429', async () => {
    // The window resetting changes nothing here, so the `Retry-After`
    // contract a 429 carries would be a lie: configuring pricing is the fix.
    const ctx = await freshProjectAndAgent('genquota-unpriced-code');
    await seedUnpricedEvents(ctx, 3);
    const quota = await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    const error = quotaBreachError(breach!);
    expect(error.code).toBe('QUOTA_UNENFORCEABLE');
    expect(error.meta).toMatchObject({
      quota_id: quota.publicId,
      metric: 'cost_usd',
    });
  });

  test('names the rows to price, so the fix does not need the rollup', async () => {
    // The operator's next action is to price exactly these; without them the
    // refusal says a price is missing but not which one (#1213).
    const ctx = await freshProjectAndAgent('genquota-unpriced-rows');
    await seedUnpricedEvents(ctx, 3);
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    const error = quotaBreachError(breach!);
    const rows = (error.meta as { unpriced_rows: unknown }).unpriced_rows;
    // `cached_tokens` measured 0 and `reasoning_tokens` is not billable —
    // pricing either changes nothing, so neither is worth reporting.
    expect(rows).toEqual([
      { provider: 'ollama', model: 'stub-model', component: 'input_tokens' },
      { provider: 'ollama', model: 'stub-model', component: 'output_tokens' },
    ]);
  });

  /**
   * The partly-priced window (#1228). Model A carries a price row, model B
   * does not: `SUM(cost_usd)` reads A's spend alone, so the cap passes on a
   * fraction of what was really spent. The blackout verdict is cleared by A,
   * so before this the window reported nothing at all — no exception, no
   * refusal, and a `current_usage` that only looks healthy.
   *
   * The signal is observability-only: the priced total is real, if
   * incomplete, so the window is still measured against the limit. Refusing
   * on a ratio is what made a cost cap unrecoverable in #1201.
   */
  test('files a triage item for a partly-priced window without refusing it', async () => {
    const ctx = await freshProjectAndAgent('genquota-unpriced-partial');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      tokens: { input: 100, output: 50 },
      model: 'priced-model',
      costUsd: '1.00',
    });
    await seedUnpricedEvents(ctx, 3);
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();

    const items = await unpricedExceptions(ctx.projectInternalId);
    expect(items).toHaveLength(1);
    const detail = items[0].detail as Record<string, unknown>;
    expect(detail.unpricedEventCount).toBe(3);
    expect(detail.meteredEventCount).toBe(4);
    // Which price row is missing — the operator's actual next question. Only
    // the unpriced model appears; the priced one has nothing to add.
    expect(detail.unpricedRows).toEqual([
      { provider: 'ollama', model: 'stub-model', component: 'input_tokens' },
      { provider: 'ollama', model: 'stub-model', component: 'output_tokens' },
    ]);
  });

  test('a partly-priced window is still measured against the limit', async () => {
    // The priced half is real spend: it must still breach on reaching the
    // cap, or the new signal would cost the enforcement it reports on.
    const ctx = await freshProjectAndAgent('genquota-unpriced-partial-cap');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      tokens: { input: 100, output: 50 },
      model: 'priced-model',
      costUsd: '5.00',
    });
    await seedUnpricedEvents(ctx, 1);
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach?.reason).toBe('limit_exceeded');
    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(1);
  });

  /**
   * The sub-case no event-level check can see: `sumComponentCostUsd` returns
   * a number when *any* component is priced, so a model with an input-token
   * price and no output-token price produces an event that counts as fully
   * priced. Reading components rather than events is what sees it.
   */
  test('names the component a partly-priced event left unpriced', async () => {
    const ctx = await freshProjectAndAgent('genquota-unpriced-component');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      tokens: { input: 100, output: 50 },
      costUsd: '0.01',
      unpricedComponents: ['output'],
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();

    const items = await unpricedExceptions(ctx.projectInternalId);
    expect(items).toHaveLength(1);
    const detail = items[0].detail as Record<string, unknown>;
    // No event was left unpriced — the gap is one dimension of a priced one.
    expect(detail.unpricedEventCount).toBe(0);
    expect(detail.unpricedRows).toEqual([
      { provider: 'ollama', model: 'stub-model', component: 'output_tokens' },
    ]);
  });

  test('files nothing when every priced event is priced in full', async () => {
    // The regression the component-level read could introduce: a window that
    // priced everything it metered must stay silent, quantities and all.
    const ctx = await freshProjectAndAgent('genquota-unpriced-full');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      tokens: { input: 100, output: 50, reasoning: 20 },
      costUsd: '1.00',
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });

    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(0);
  });

  test('an unpriced embedding beside priced usage files nothing', async () => {
    // The carve-out holds for the partial case too: an embedding has no price
    // row a tenant can create, so reporting it sends nobody anywhere.
    const ctx = await freshProjectAndAgent('genquota-unpriced-part-embed');
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
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });

    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(0);
  });

  test('an unpriced platform meter beside priced usage files nothing', async () => {
    // Priced by the operator from a `soat` SKU, not by a tenant's provider —
    // so a deployment that prices no compute is not a project's pricing gap.
    const ctx = await freshProjectAndAgent('genquota-unpriced-part-compute');
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
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });

    expect(await unpricedExceptions(ctx.projectInternalId)).toHaveLength(0);
  });

  test('an embedding is never named as a row to price', async () => {
    // It has no price book row to create — the deployment variable is the
    // only place its rate lives — so naming it would send the operator to a
    // route that cannot fix anything.
    const ctx = await freshProjectAndAgent('genquota-unpriced-rows-embed');
    await seedUnpricedEvents(ctx, 3);
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      source: 'embedding',
      provider: 'openai',
      model: 'text-embedding-3-small',
      costUsd: null,
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    const rows = (
      quotaBreachError(breach!).meta as {
        unpriced_rows: Array<{ model: string }>;
      }
    ).unpriced_rows;
    expect(
      rows.some((row) => {
        return row.model === 'text-embedding-3-small';
      })
    ).toBe(false);
  });
});
