import { db } from 'src/db';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';

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
 * Token and cost quotas, read by the check every generation passes before it
 * reaches a model. The refusal body names the quota that fired, so each case
 * pins which combination of scope × metric × window × attribution it was.
 * Usage rows are seeded directly — there is no create API for a metered event.
 *
 * The agents' provider is a local stub whose model carries a zero price, so a
 * generation the check admits completes and meters a priced, zero-cost event
 * that moves no cost total and clears no pricing gap.
 */

const ADMIT_MODEL = 'quota-admit-model';

type Fresh = Awaited<ReturnType<typeof freshProjectAndAgent>>;

describe('POST /api/v1/agents/:agent_id/generate — token and cost quotas', () => {
  let adminToken: string;
  let stub: StubChatProvider;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'genquota',
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

  const createQuota = async (
    ctx: Fresh,
    body: Record<string, unknown>
  ): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/quotas')
      .send({
        project_id: ctx.projectPublicId,
        window: 'calendar_month',
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generate = (agentId: string) => {
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
  };

  const generateInSession = async (sessionId: string) => {
    const message = await authenticatedTestClient(adminToken)
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .send({ message: 'hello' });
    expect(message.status).toBe(201);
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/sessions/${sessionId}/generate?wait=true`)
      .send({});
  };

  const expectAdmitted = (res: {
    status: number;
    body: { status?: string };
  }) => {
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  };

  const expectRefusedBy = (
    res: { status: number; body: { error?: { code: string; meta: object } } },
    quotaId: string
  ) => {
    expect(res.status).toBe(429);
    expect(res.body.error?.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.error?.meta).toMatchObject({ quota_id: quotaId });
  };

  // The firing is awaited inside the check, so no polling is needed.
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

  const createSecondAgent = async (ctx: Fresh): Promise<number> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: ctx.projectPublicId,
        ai_provider_id: ctx.aiProviderPublicId,
        name: 'other agent',
      });
    expect(res.status).toBe(201);
    const agent = await db.Agent.findOne({ where: { publicId: res.body.id } });
    return agent!.id as number;
  };

  describe('cost_usd', () => {
    test('refuses once the window sum reaches the limit', async () => {
      const ctx = await fresh('genquota-cost-breach');
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
      const quotaId = await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 5,
      });

      const res = await generate(ctx.agentPublicId);

      expectRefusedBy(res, quotaId);
      expect(res.body.error.meta).toMatchObject({
        metric: 'cost_usd',
        limit: 5,
        window: 'calendar_month',
      });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    test('admits a window below the limit', async () => {
      const ctx = await fresh('genquota-cost-under');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        costUsd: '4.99',
      });
      await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 5,
      });

      expectAdmitted(await generate(ctx.agentPublicId));
    });

    test('a monitor quota fires quota.exceeded without blocking', async () => {
      const ctx = await fresh('genquota-monitor-fire');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        costUsd: '100.00',
      });
      const quotaId = await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 1,
        mode: 'monitor',
      });

      const captured = await withCapture(async () => {
        expectAdmitted(await generate(ctx.agentPublicId));
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].resourceType).toBe('quota');
      expect(captured[0].data).toMatchObject({
        quota_id: quotaId,
        mode: 'monitor',
        metric: 'cost_usd',
      });
    });

    test('an enforce breach fires quota.exceeded once per window', async () => {
      const ctx = await fresh('genquota-enforce-fire');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        costUsd: '5.00',
      });
      const quotaId = await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 5,
      });

      const captured = await withCapture(async () => {
        expectRefusedBy(await generate(ctx.agentPublicId), quotaId);
        // A second breach in the same window still refuses, but does not
        // re-fire.
        expectRefusedBy(await generate(ctx.agentPublicId), quotaId);
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].data.mode).toBe('enforce');
    });

    test('an unpriced refusal fires no quota.exceeded — nothing was exceeded', async () => {
      const ctx = await fresh('genquota-unpriced-nofire');
      for (let i = 0; i < 3; i += 1) {
        await seedUsageEvent({
          projectInternalId: ctx.projectInternalId,
          agentInternalId: ctx.agentInternalId,
          costUsd: null,
        });
      }
      await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 5,
      });

      const captured = await withCapture(async () => {
        const res = await generate(ctx.agentPublicId);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('QUOTA_UNENFORCEABLE');
      });

      // The limit was never reached — it cannot be. Firing the breach webhook
      // would report a spend figure the platform does not have.
      expect(captured).toHaveLength(0);
    });
  });

  describe('tokens', () => {
    test('sums billable token components, reasoning excluded', async () => {
      const ctx = await fresh('genquota-tokens');
      // 6 + 20 + 4 = 30 billable tokens; the 100 reasoning tokens do not count.
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        tokens: { input: 6, output: 20, cached: 4, reasoning: 100 },
      });
      const quotaId = await createQuota(ctx, {
        scope: 'project',
        metric: 'tokens',
        limit: 30,
      });

      expectRefusedBy(await generate(ctx.agentPublicId), quotaId);
    });

    test('reasoning tokens never tip the window over', async () => {
      const ctx = await fresh('genquota-tokens-under');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        tokens: { input: 10, output: 10, reasoning: 100 },
      });
      await createQuota(ctx, { scope: 'project', metric: 'tokens', limit: 30 });

      expectAdmitted(await generate(ctx.agentPublicId));
    });

    test('usage before the window starts is not counted', async () => {
      const ctx = await fresh('genquota-window');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        tokens: { input: 100 },
        createdAt: new Date(Date.now() - 2 * 60 * 1000),
      });
      await createQuota(ctx, {
        scope: 'project',
        metric: 'tokens',
        window: 'rolling_1m',
        limit: 1,
      });

      expectAdmitted(await generate(ctx.agentPublicId));
    });

    test('an api_key-scoped token quota is never aggregated', async () => {
      const ctx = await fresh('genquota-apikey-skip');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100 },
      });
      // Written beneath the create-time validation, which refuses this
      // combination: usage events carry no api-key attribution to sum.
      await createQuotaRow({
        projectInternalId: ctx.projectInternalId,
        scope: 'api_key',
        scopeRef: 'key_someapikey000000',
        metric: 'tokens',
        limit: 1,
      });

      expectAdmitted(await generate(ctx.agentPublicId));
    });
  });

  describe('agent and project scope', () => {
    test('an agent-scoped quota counts only the named agent', async () => {
      const ctx = await fresh('genquota-agent-scope');
      const otherAgentId = await createSecondAgent(ctx);
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 10 },
      });
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: otherAgentId,
        tokens: { input: 100 },
      });
      await createQuota(ctx, {
        scope: 'agent',
        scope_ref: ctx.agentPublicId,
        metric: 'tokens',
        limit: 30,
      });

      expectAdmitted(await generate(ctx.agentPublicId));
    });

    test('a project-scoped quota counts every agent in the project', async () => {
      const ctx = await fresh('genquota-project-scope');
      const otherAgentId = await createSecondAgent(ctx);
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 10 },
      });
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: otherAgentId,
        tokens: { input: 100 },
      });
      const quotaId = await createQuota(ctx, {
        scope: 'project',
        metric: 'tokens',
        limit: 30,
      });

      expectRefusedBy(await generate(ctx.agentPublicId), quotaId);
    });

    test('names the agent quota when it and the project quota both breach', async () => {
      const ctx = await fresh('genquota-specificity');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 50 },
      });
      await createQuota(ctx, { scope: 'project', metric: 'tokens', limit: 10 });
      const agentQuotaId = await createQuota(ctx, {
        scope: 'agent',
        scope_ref: ctx.agentPublicId,
        metric: 'tokens',
        limit: 10,
      });

      expectRefusedBy(await generate(ctx.agentPublicId), agentQuotaId);
    });
  });

  // The actor is derived from the session, as usage attribution does, so a
  // caller can never bill one actor under another's session.
  describe('actor scope', () => {
    const openSession = async (ctx: Fresh, name: string) => {
      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: ctx.projectPublicId, name });
      expect(actorRes.status).toBe(201);
      const sessionRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/sessions')
        .send({ agent_id: ctx.agentPublicId, actor_id: actorRes.body.id });
      expect(sessionRes.status).toBe(201);
      const actor = await db.Actor.findOne({
        where: { publicId: actorRes.body.id },
      });
      return {
        actorPublicId: actorRes.body.id as string,
        sessionPublicId: sessionRes.body.id as string,
        actorInternalId: actor!.id as number,
      };
    };

    test('a scope_ref actor quota counts only that actor', async () => {
      const ctx = await fresh('genquota-actor-ref');
      const alice = await openSession(ctx, 'alice');
      const bob = await openSession(ctx, 'bob');
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
      const quotaId = await createQuota(ctx, {
        scope: 'actor',
        scope_ref: bob.actorPublicId,
        metric: 'tokens',
        limit: 50,
      });

      expectRefusedBy(await generateInSession(bob.sessionPublicId), quotaId);
      // The project total (110) is over the limit, but the quota names Bob.
      expectAdmitted(await generateInSession(alice.sessionPublicId));
    });

    test('an actor quota never matches a generation with no session', async () => {
      const ctx = await fresh('genquota-actor-nosession');
      const alice = await openSession(ctx, 'alice');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        actorInternalId: alice.actorInternalId,
        tokens: { input: 100 },
      });
      await createQuota(ctx, { scope: 'actor', metric: 'tokens', limit: 50 });

      // A direct generation has no end user behind it; a project quota is what
      // caps that traffic.
      expectAdmitted(await generate(ctx.agentPublicId));
    });

    test('an actor quota never matches a session that has no actor', async () => {
      const ctx = await fresh('genquota-actor-actorless');
      const sessionRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/sessions')
        .send({ agent_id: ctx.agentPublicId });
      expect(sessionRes.status).toBe(201);
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        tokens: { input: 100 },
      });
      await createQuota(ctx, { scope: 'actor', metric: 'tokens', limit: 50 });

      expectAdmitted(await generateInSession(sessionRes.body.id));
    });

    test('names the actor quota over agent and project quotas', async () => {
      const ctx = await fresh('genquota-actor-specificity');
      const alice = await openSession(ctx, 'alice');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        agentInternalId: ctx.agentInternalId,
        actorInternalId: alice.actorInternalId,
        tokens: { input: 100 },
      });
      await createQuota(ctx, { scope: 'project', metric: 'tokens', limit: 10 });
      await createQuota(ctx, {
        scope: 'agent',
        scope_ref: ctx.agentPublicId,
        metric: 'tokens',
        limit: 10,
      });
      const actorQuotaId = await createQuota(ctx, {
        scope: 'actor',
        scope_ref: alice.actorPublicId,
        metric: 'tokens',
        limit: 10,
      });

      expectRefusedBy(
        await generateInSession(alice.sessionPublicId),
        actorQuotaId
      );
    });

    test("an actor cost quota sums only that actor's priced spend", async () => {
      const ctx = await fresh('genquota-actor-cost');
      const alice = await openSession(ctx, 'alice');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        actorInternalId: alice.actorInternalId,
        costUsd: '2.50',
      });
      // Unattributed spend in the same project does not count against her cap.
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        costUsd: '99.00',
      });
      const quotaId = await createQuota(ctx, {
        scope: 'actor',
        scope_ref: alice.actorPublicId,
        metric: 'cost_usd',
        limit: 5,
      });

      expectAdmitted(await generateInSession(alice.sessionPublicId));

      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        actorInternalId: alice.actorInternalId,
        costUsd: '3.00',
      });
      expectRefusedBy(await generateInSession(alice.sessionPublicId), quotaId);
    });
  });

  // A `cost_usd` cap with no meter scope answers for every priced meter, and a
  // scoped one for the meter it names — which is what lets a tenant cap AI
  // spend without the operator's platform pricing landing in the same slot.
  describe('meter-scoped cost quotas', () => {
    const seedBothMeters = async (ctx: Fresh) => {
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

    test('an unscoped cost quota sums every meter', async () => {
      const ctx = await fresh('genquota-meter-unscoped');
      await seedBothMeters(ctx);
      const quotaId = await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 7,
      });

      expectRefusedBy(await generate(ctx.agentPublicId), quotaId);
    });

    test('a quota scoped to the AI meter ignores platform spend', async () => {
      const ctx = await fresh('genquota-meter-ai');
      await seedBothMeters(ctx);
      await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 7,
        meter_type: 'llm_tokens',
      });

      expectAdmitted(await generate(ctx.agentPublicId));
    });

    test('a quota scoped to a platform meter ignores AI spend', async () => {
      const ctx = await fresh('genquota-meter-storage-under');
      await seedBothMeters(ctx);
      await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 4,
        meter_type: 'storage',
      });

      expectAdmitted(await generate(ctx.agentPublicId));
    });

    // The breach payload restates the quota's identity so a consumer can act
    // on it without a fetch; with two caps over one window the meter is the
    // half that says which budget blew.
    test('a platform-meter quota breaches on that meter alone and the webhook names it', async () => {
      const ctx = await fresh('genquota-meter-storage-over');
      await seedBothMeters(ctx);
      const quotaId = await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 3,
        meter_type: 'storage',
      });

      const captured = await withCapture(async () => {
        expectRefusedBy(await generate(ctx.agentPublicId), quotaId);
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].data).toMatchObject({
        quota_id: quotaId,
        meter_type: 'storage',
      });
    });

    test('an AI-scoped and a platform-scoped quota hold separate budgets', async () => {
      const ctx = await fresh('genquota-meter-both');
      await seedBothMeters(ctx);
      const aiQuotaId = await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 4,
        meter_type: 'llm_tokens',
      });
      await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 10,
        meter_type: 'storage',
      });

      expectRefusedBy(await generate(ctx.agentPublicId), aiQuotaId);
    });
  });

  describe('resilience', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    // Sanctioned force-failure: the fail-open branch is reached only when the
    // check's own read rejects, which no real query does deterministically.
    test('fails open when the quota read errors', async () => {
      const ctx = await fresh('genquota-fail-open');
      await seedUsageEvent({
        projectInternalId: ctx.projectInternalId,
        costUsd: '100.00',
      });
      await createQuota(ctx, {
        scope: 'project',
        metric: 'cost_usd',
        limit: 1,
      });
      const read = jest
        .spyOn(db.Quota, 'findAll')
        .mockRejectedValueOnce(new Error('db unavailable'));

      expectAdmitted(await generate(ctx.agentPublicId));
      expect(read).toHaveBeenCalled();
    });
  });
});
