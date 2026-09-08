import { db } from 'src/db';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';
import {
  checkGenerationQuota,
  evaluateGenerationQuotas,
} from 'src/lib/quotaEnforcement';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  createQuotaRow,
  freshProjectAndAgent as freshProjectAndAgentFixture,
  seedUsageEvent,
} from '../../fixtures/quotaSeed';
import { authenticatedTestClient } from '../../testClient';

// A pure aggregation over scope × metric × window × attribution, where a bare
// 429 through a live generation would hide which combination fired. Usage rows
// are seeded directly — there is no create API for metered events.

describe('evaluateGenerationQuotas', () => {
  let adminToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'genquota',
      policyActions: [],
    });
    adminToken = setup.adminToken;
  });

  const freshProjectAndAgent = (name: string) => {
    return freshProjectAndAgentFixture({ adminToken, name });
  };

  test('breaches a project cost_usd quota when the window sum reaches the limit', async () => {
    const ctx = await freshProjectAndAgent('genquota-cost-breach');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      costUsd: '3.00',
    });
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      costUsd: '2.00',
    });
    const quota = await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).not.toBeNull();
    expect(breach!.quotaId).toBe(quota.publicId);
    expect(breach!.metric).toBe('cost_usd');
    expect(breach!.scope).toBe('project');
    expect(breach!.window).toBe('calendar_month');
    expect(breach!.limit).toBe(5);
    expect(breach!.resetsAt instanceof Date).toBe(true);
    expect(breach!.retryAfter).toBeGreaterThan(0);
  });

  test('does not breach when the window sum is below the limit', async () => {
    const ctx = await freshProjectAndAgent('genquota-cost-under');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      costUsd: '4.99',
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
  });

  test('tokens metric sums billable token components only (reasoning excluded)', async () => {
    const ctx = await freshProjectAndAgent('genquota-tokens');
    // 6 + 20 + 4 = 30 billable tokens; 100 reasoning tokens must not count.
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      tokens: { input: 6, output: 20, cached: 4, reasoning: 100 },
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'tokens',
      limit: 30,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).not.toBeNull();
    expect(breach!.metric).toBe('tokens');
  });

  test('tokens metric stays under the limit when reasoning would have tipped it', async () => {
    const ctx = await freshProjectAndAgent('genquota-tokens-under');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      tokens: { input: 10, output: 10, reasoning: 100 },
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'tokens',
      limit: 30,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();
  });

  test('an agent-scoped quota aggregates only the named agent', async () => {
    const ctx = await freshProjectAndAgent('genquota-agent-scope');
    // A second agent in the same project whose spend must not count.
    const otherAgentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: ctx.projectPublicId,
        ai_provider_id: (await db.AiProvider.findOne({
          where: { projectId: ctx.projectInternalId },
        }))!.publicId,
        name: 'other agent',
      });
    const otherAgent = await db.Agent.findOne({
      where: { publicId: otherAgentRes.body.id },
    });

    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      tokens: { input: 10 },
    });
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: (otherAgent as unknown as { id: number }).id,
      tokens: { input: 100 },
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'agent',
      scopeRef: ctx.agentPublicId,
      metric: 'tokens',
      limit: 30,
    });

    // This agent contributed only 10 tokens — the other agent's 100 is excluded.
    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();
  });

  test('a project-scoped quota aggregates every agent in the project', async () => {
    const ctx = await freshProjectAndAgent('genquota-project-scope');
    const otherAgentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: ctx.projectPublicId,
        ai_provider_id: (await db.AiProvider.findOne({
          where: { projectId: ctx.projectInternalId },
        }))!.publicId,
        name: 'other agent',
      });
    const otherAgent = await db.Agent.findOne({
      where: { publicId: otherAgentRes.body.id },
    });

    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      tokens: { input: 10 },
    });
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: (otherAgent as unknown as { id: number }).id,
      tokens: { input: 100 },
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'tokens',
      limit: 30,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).not.toBeNull();
    expect(breach!.scope).toBe('project');
  });

  test('reports the most specific scope when both a project and agent quota breach', async () => {
    const ctx = await freshProjectAndAgent('genquota-specificity');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      tokens: { input: 50 },
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'tokens',
      limit: 10,
    });
    const agentQuota = await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'agent',
      scopeRef: ctx.agentPublicId,
      metric: 'tokens',
      limit: 10,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).not.toBeNull();
    expect(breach!.scope).toBe('agent');
    expect(breach!.quotaId).toBe(agentQuota.publicId);
  });

  test('usage outside the current window is not counted', async () => {
    const ctx = await freshProjectAndAgent('genquota-window');
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      tokens: { input: 100 },
      createdAt: twoMinutesAgo,
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'tokens',
      window: 'rolling_1m',
      limit: 1,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();
  });

  test('monitor-mode quotas never block (Phase 2)', async () => {
    const ctx = await freshProjectAndAgent('genquota-monitor');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      costUsd: '100.00',
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 1,
      mode: 'monitor',
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();
  });

  test('api_key-scoped token/cost quotas are never aggregated', async () => {
    const ctx = await freshProjectAndAgent('genquota-apikey-skip');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      tokens: { input: 100 },
    });
    // Bypasses the create-time validation (which rejects this combination) to
    // prove the evaluator defensively skips a stray api_key token/cost quota.
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'api_key',
      scopeRef: 'key_someapikey000000',
      metric: 'tokens',
      limit: 1,
    });

    const breach = await evaluateGenerationQuotas({
      agentId: ctx.agentPublicId,
    });
    expect(breach).toBeNull();
  });

  test('returns null when the agent does not exist', async () => {
    const breach = await evaluateGenerationQuotas({
      agentId: 'agent_doesnotexist00',
    });
    expect(breach).toBeNull();
  });

  // Collects `quota.exceeded` events emitted while `action` runs, tearing the
  // listener down afterward so it never leaks into later tests. The firing is
  // awaited inside evaluateGenerationQuotas, so no polling is needed.
  const withCapture = async (
    action: () => Promise<void>
  ): Promise<SoatEvent[]> => {
    const captured: SoatEvent[] = [];
    const handler = (event: SoatEvent) => {
      if (event.type === 'quota.exceeded') captured.push(event);
    };
    eventBus.on('soat:event', handler);
    try {
      await action();
    } finally {
      eventBus.off('soat:event', handler);
    }
    return captured;
  };

  test('an unpriced refusal fires no quota.exceeded — nothing exceeded', async () => {
    const ctx = await freshProjectAndAgent('genquota-unpriced-nofire');
    for (let i = 0; i < 3; i += 1) {
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        costUsd: null,
      });
    }
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const captured = await withCapture(async () => {
      const breach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
      });
      expect(breach?.reason).toBe('unpriced_usage');
    });

    // The limit was never reached — it cannot be. Firing the breach webhook
    // would report a spend figure the platform does not have.
    expect(captured).toHaveLength(0);
  });

  test('a monitor token/cost quota fires quota.exceeded without blocking', async () => {
    const ctx = await freshProjectAndAgent('genquota-monitor-fire');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      costUsd: '100.00',
    });
    const quota = await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 1,
      mode: 'monitor',
    });

    let breach: Awaited<ReturnType<typeof evaluateGenerationQuotas>> = null;
    const captured = await withCapture(async () => {
      breach = await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });
    });

    expect(breach).toBeNull(); // monitor never blocks
    expect(captured).toHaveLength(1);
    expect(captured[0].data.quota_id).toBe(quota.publicId);
    expect(captured[0].data.mode).toBe('monitor');
    expect(captured[0].data.metric).toBe('cost_usd');
    expect(captured[0].resourceType).toBe('quota');
  });

  test('an enforce token/cost breach fires quota.exceeded once per window', async () => {
    const ctx = await freshProjectAndAgent('genquota-enforce-fire');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      costUsd: '5.00',
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 5,
    });

    const captured = await withCapture(async () => {
      const first = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
      });
      expect(first).not.toBeNull();
      // A second breach in the same window still blocks but does not re-fire.
      const second = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
      });
      expect(second).not.toBeNull();
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].data.mode).toBe('enforce');
  });

  // The actor is derived from the session, as usage attribution does, so a
  // caller can never bill one actor under another's session. A generation with
  // no session has no actor and is never matched.
  describe('actor scope', () => {
    const createActorAndSession = async (opts: {
      projectPublicId: string;
      agentPublicId: string;
      name: string;
    }) => {
      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: opts.projectPublicId, name: opts.name });
      expect(actorRes.status).toBe(201);

      const sessionRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/sessions')
        .send({
          agent_id: opts.agentPublicId,
          actor_id: actorRes.body.id,
        });
      expect(sessionRes.status).toBe(201);

      const actor = await db.Actor.findOne({
        where: { publicId: actorRes.body.id },
      });

      return {
        actorPublicId: actorRes.body.id as string,
        sessionPublicId: sessionRes.body.id as string,
        actorInternalId: (actor as unknown as { id: number }).id,
      };
    };

    test('a scope_ref actor quota aggregates only that actor', async () => {
      const ctx = await freshProjectAndAgent('genquota-actor-ref');
      const alice = await createActorAndSession({
        projectPublicId: ctx.projectPublicId,
        agentPublicId: ctx.agentPublicId,
        name: 'alice',
      });
      const bob = await createActorAndSession({
        projectPublicId: ctx.projectPublicId,
        agentPublicId: ctx.agentPublicId,
        name: 'bob',
      });

      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        actorInternalId: alice.actorInternalId,
        tokens: { input: 10 },
      });
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        actorInternalId: bob.actorInternalId,
        tokens: { input: 100 },
      });

      const quota = await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'actor',
        scopeRef: bob.actorPublicId,
        metric: 'tokens',
        limit: 50,
      });

      // Bob is over (100 >= 50) — his own session breaches.
      const bobBreach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
        sessionId: bob.sessionPublicId,
      });
      expect(bobBreach).not.toBeNull();
      expect(bobBreach!.scope).toBe('actor');
      expect(bobBreach!.quotaId).toBe(quota.publicId);

      // Alice's session does not match a quota that names Bob, even though the
      // project total (110) is over the limit.
      const aliceBreach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
        sessionId: alice.sessionPublicId,
      });
      expect(aliceBreach).toBeNull();
    });

    test('a null-ref actor quota caps each actor independently', async () => {
      const ctx = await freshProjectAndAgent('genquota-actor-nullref');
      const alice = await createActorAndSession({
        projectPublicId: ctx.projectPublicId,
        agentPublicId: ctx.agentPublicId,
        name: 'alice',
      });
      const bob = await createActorAndSession({
        projectPublicId: ctx.projectPublicId,
        agentPublicId: ctx.agentPublicId,
        name: 'bob',
      });

      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        actorInternalId: alice.actorInternalId,
        tokens: { input: 10 },
      });
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        actorInternalId: bob.actorInternalId,
        tokens: { input: 100 },
      });

      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'actor',
        scopeRef: null,
        metric: 'tokens',
        limit: 50,
      });

      // One budget per actor, not one shared budget: Bob's 100 breaches while
      // Alice's 10 does not, even though the project sum (110) is over.
      const bobBreach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
        sessionId: bob.sessionPublicId,
      });
      expect(bobBreach).not.toBeNull();
      expect(bobBreach!.scope).toBe('actor');

      const aliceBreach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
        sessionId: alice.sessionPublicId,
      });
      expect(aliceBreach).toBeNull();
    });

    test('an actor quota never matches a generation with no session', async () => {
      const ctx = await freshProjectAndAgent('genquota-actor-nosession');
      const alice = await createActorAndSession({
        projectPublicId: ctx.projectPublicId,
        agentPublicId: ctx.agentPublicId,
        name: 'alice',
      });
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        actorInternalId: alice.actorInternalId,
        tokens: { input: 100 },
      });
      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'actor',
        scopeRef: null,
        metric: 'tokens',
        limit: 50,
      });

      // A direct API generation has no end user behind it, so a per-end-user
      // cap has nothing to apply to. Use a project quota to cap that traffic.
      const breach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
      });
      expect(breach).toBeNull();
    });

    test('an actor quota never matches a session that has no actor', async () => {
      const ctx = await freshProjectAndAgent('genquota-actor-actorless');
      const sessionRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/sessions')
        .send({
          agent_id: ctx.agentPublicId,
        });
      expect(sessionRes.status).toBe(201);

      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100 },
      });
      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'actor',
        scopeRef: null,
        metric: 'tokens',
        limit: 50,
      });

      const breach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
        sessionId: sessionRes.body.id,
      });
      expect(breach).toBeNull();
    });

    test('a session from another project resolves no actor', async () => {
      const ctx = await freshProjectAndAgent('genquota-actor-crossproject');
      const other = await freshProjectAndAgent('genquota-actor-crossother');
      const stranger = await createActorAndSession({
        projectPublicId: other.projectPublicId,
        agentPublicId: other.agentPublicId,
        name: 'stranger',
      });

      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100 },
      });
      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'actor',
        scopeRef: null,
        metric: 'tokens',
        limit: 50,
      });

      // The session id is real but belongs to a different project, so it must
      // not resolve an actor into this project's enforcement.
      const breach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
        sessionId: stranger.sessionPublicId,
      });
      expect(breach).toBeNull();
    });

    test('reports actor as the most specific scope over agent and project', async () => {
      const ctx = await freshProjectAndAgent('genquota-actor-specificity');
      const alice = await createActorAndSession({
        projectPublicId: ctx.projectPublicId,
        agentPublicId: ctx.agentPublicId,
        name: 'alice',
      });
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        actorInternalId: alice.actorInternalId,
        tokens: { input: 100 },
      });

      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'project',
        metric: 'tokens',
        limit: 10,
      });
      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'agent',
        scopeRef: ctx.agentPublicId,
        metric: 'tokens',
        limit: 10,
      });
      const actorQuota = await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'actor',
        scopeRef: alice.actorPublicId,
        metric: 'tokens',
        limit: 10,
      });

      const breach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
        sessionId: alice.sessionPublicId,
      });
      expect(breach).not.toBeNull();
      expect(breach!.scope).toBe('actor');
      expect(breach!.quotaId).toBe(actorQuota.publicId);
    });

    test('an actor cost_usd quota sums only that actor priced spend', async () => {
      const ctx = await freshProjectAndAgent('genquota-actor-cost');
      const alice = await createActorAndSession({
        projectPublicId: ctx.projectPublicId,
        agentPublicId: ctx.agentPublicId,
        name: 'alice',
      });
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        actorInternalId: alice.actorInternalId,
        costUsd: '2.50',
      });
      // Unattributed spend in the same project must not count against her cap.
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        costUsd: '99.00',
      });

      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'actor',
        scopeRef: alice.actorPublicId,
        metric: 'cost_usd',
        limit: 5,
      });

      const under = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
        sessionId: alice.sessionPublicId,
      });
      expect(under).toBeNull();

      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        actorInternalId: alice.actorInternalId,
        costUsd: '3.00',
      });
      const over = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
        sessionId: alice.sessionPublicId,
      });
      expect(over).not.toBeNull();
      expect(over!.metric).toBe('cost_usd');
    });
  });

  // A `cost_usd` cap with no meter scope answers for every priced meter, and a
  // scoped one answers for the meter it names — which is what lets a tenant cap
  // AI spend without the operator's platform pricing landing in the same slot.
  describe('meter-scoped cost quotas', () => {
    const seedBothMeters = async (ctx: {
      projectInternalId: number;
      agentInternalId: number;
    }) => {
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        costUsd: '4.00',
      });
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        meterType: 'storage',
        costUsd: '3.00',
      });
    };

    test('an unscoped cost quota still sums every meter', async () => {
      const ctx = await freshProjectAndAgent('genquota-meter-unscoped');
      await seedBothMeters(ctx);
      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'project',
        metric: 'cost_usd',
        limit: 7,
      });

      const breach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
      });
      expect(breach?.reason).toBe('limit_exceeded');
    });

    test('a quota scoped to the AI meter ignores platform spend', async () => {
      const ctx = await freshProjectAndAgent('genquota-meter-ai');
      await seedBothMeters(ctx);
      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'project',
        metric: 'cost_usd',
        limit: 7,
        meterType: 'llm_tokens',
      });

      const breach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
      });
      expect(breach).toBeNull();
    });

    test('a quota scoped to a platform meter ignores AI spend', async () => {
      const ctx = await freshProjectAndAgent('genquota-meter-storage-under');
      await seedBothMeters(ctx);
      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'project',
        metric: 'cost_usd',
        limit: 4,
        meterType: 'storage',
      });

      const breach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
      });
      expect(breach).toBeNull();
    });

    test('a quota scoped to a platform meter breaches on that meter alone', async () => {
      const ctx = await freshProjectAndAgent('genquota-meter-storage-over');
      await seedBothMeters(ctx);
      const quota = await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'project',
        metric: 'cost_usd',
        limit: 3,
        meterType: 'storage',
      });

      const breach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
      });
      expect(breach?.quotaId).toBe(quota.publicId);
      expect(breach?.reason).toBe('limit_exceeded');
    });

    // Both slots side by side is the whole point of the scope: the AI cap is
    // breached while the storage cap, holding the same window, is not.
    // The breach payload restates the quota's identity so a consumer can act on
    // it without a fetch; with two caps over one window the meter is the half
    // that says which budget blew.
    test('the breach webhook names the meter the cap answers for', async () => {
      const ctx = await freshProjectAndAgent('genquota-meter-webhook');
      await seedBothMeters(ctx);
      const quota = await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'project',
        metric: 'cost_usd',
        limit: 3,
        meterType: 'storage',
      });

      const captured = await withCapture(async () => {
        await evaluateGenerationQuotas({ agentId: ctx.agentPublicId });
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].data.quota_id).toBe(quota.publicId);
      expect(captured[0].data.meter_type).toBe('storage');
    });

    test('an AI-scoped and a platform-scoped quota hold separate budgets', async () => {
      const ctx = await freshProjectAndAgent('genquota-meter-both');
      await seedBothMeters(ctx);
      const aiQuota = await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'project',
        metric: 'cost_usd',
        limit: 4,
        meterType: 'llm_tokens',
      });
      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'project',
        metric: 'cost_usd',
        limit: 10,
        meterType: 'storage',
      });

      const breach = await evaluateGenerationQuotas({
        agentId: ctx.agentPublicId,
      });
      expect(breach?.quotaId).toBe(aiQuota.publicId);
    });
  });

  test('checkGenerationQuota fails open on an infrastructure error', async () => {
    const ctx = await freshProjectAndAgent('genquota-fail-open');
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      costUsd: '100.00',
    });
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'cost_usd',
      limit: 1,
    });

    // Sanctioned force-failure stub (tests.md): the fail-open branch can only
    // be exercised by making the check's DB read reject — no real query fails
    // deterministically. It must then return null (generation proceeds) rather
    // than surfacing the error or a breach.
    const spy = jest
      .spyOn(db.Agent, 'findOne')
      .mockRejectedValueOnce(new Error('db unavailable'));
    try {
      const breach = await checkGenerationQuota({
        agentId: ctx.agentPublicId,
      });
      expect(breach).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
