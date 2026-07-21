import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { db } from 'src/db';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';
import {
  checkGenerationQuota,
  evaluateGenerationQuotas,
} from 'src/lib/quotaEnforcement';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// Direct lib test for the token/cost pre-generation check. Justified under the
// keep-list rule: a pure aggregation algorithm over a large input space
// (scope × metric × window × attribution) whose only external I/O is the real
// DB. Driving every branch through a live LLM generation would be slow and
// low-resolution (a bare 429 hides which scope/window fired). Usage rows are
// seeded directly — there is no create API for metered events.

describe('evaluateGenerationQuotas', () => {
  let adminToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'genquota',
      policyActions: [],
    });
    adminToken = setup.adminToken;
  });

  // A fresh project + agent per test so windowed aggregation is isolated by
  // project id — no cross-test usage bleed and no global cleanup.
  const freshProjectAndAgent = async (name: string) => {
    const projRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name });
    const projectPublicId = projRes.body.id as string;

    const provRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectPublicId,
        name: `${name} provider`,
        provider: 'ollama',
        default_model: 'stub-model',
      });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectPublicId,
        ai_provider_id: provRes.body.id,
        name: `${name} agent`,
      });
    const agentPublicId = agentRes.body.id as string;

    const project = await db.Project.findOne({
      where: { publicId: projectPublicId },
    });
    const agent = await db.Agent.findOne({
      where: { publicId: agentPublicId },
    });

    return {
      projectPublicId,
      agentPublicId,
      projectInternalId: (project as unknown as { id: number }).id,
      agentInternalId: (agent as unknown as { id: number }).id,
    };
  };

  const seedUsageEvent = async (opts: {
    projectInternalId: number;
    agentInternalId?: number | null;
    tokens?: {
      input?: number;
      output?: number;
      cached?: number;
      reasoning?: number;
    };
    costUsd?: string | null;
    createdAt?: Date;
  }) => {
    const event = await db.UsageEvent.create({
      projectId: opts.projectInternalId,
      agentId: opts.agentInternalId ?? null,
      meterType: 'llm_tokens',
      provider: 'ollama',
      model: 'stub-model',
      costUsd: opts.costUsd ?? null,
      idempotencyKey: `${generatePublicId(PUBLIC_ID_PREFIXES.usageEvent)}:seed`,
    });
    const t = opts.tokens ?? {};
    const comps = [
      { component: 'input_tokens', quantity: t.input ?? 0, billable: true },
      { component: 'output_tokens', quantity: t.output ?? 0, billable: true },
      { component: 'cached_tokens', quantity: t.cached ?? 0, billable: true },
      {
        component: 'reasoning_tokens',
        quantity: t.reasoning ?? 0,
        billable: false,
      },
    ];
    await db.UsageComponent.bulkCreate(
      comps.map((c) => {
        return {
          // bulkCreate does not fire the beforeValidate publicId hook, so set it
          // explicitly (as the production write path in usageRecording does).
          publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
          usageEventId: (event as unknown as { id: number }).id,
          component: c.component,
          quantity: String(c.quantity),
          unit: 'token',
          billable: c.billable,
          unitPrice: null,
          costUsd: null,
          priceId: null,
        };
      })
    );
    if (opts.createdAt) {
      await db.UsageEvent.update(
        { createdAt: opts.createdAt },
        { where: { id: (event as unknown as { id: number }).id }, silent: true }
      );
    }
    return event;
  };

  const createQuotaRow = async (opts: {
    projectInternalId: number;
    scope: string;
    scopeRef?: string | null;
    metric: string;
    window?: string;
    limit: number;
    mode?: string;
  }) => {
    const quota = await db.Quota.create({
      projectId: opts.projectInternalId,
      scope: opts.scope,
      scopeRef: opts.scopeRef ?? null,
      metric: opts.metric,
      window: opts.window ?? 'calendar_month',
      limit: String(opts.limit),
      mode: opts.mode ?? 'enforce',
    });
    return quota;
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
