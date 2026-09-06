import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { db } from 'src/db';

import { authenticatedTestClient } from '../testClient';

type QuotaInstance = InstanceType<(typeof db)['Quota']>;
type UsageEventInstance = InstanceType<(typeof db)['UsageEvent']>;

type TokenQuantities = {
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
};

/**
 * Seeding for the quota suites.
 *
 * There is no create API for a metered event, so a windowed aggregation test
 * writes its own rows. Shared rather than copied so the two suites that read
 * them — enforcement and the unpriced-usage postures — cannot drift on what a
 * seeded event looks like.
 */

// A fresh project + agent per test so windowed aggregation is isolated by
// project id — no cross-test usage bleed and no global cleanup.
export const freshProjectAndAgent = async (args: {
  adminToken: string;
  name: string;
}) => {
  const { adminToken, name } = args;
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

const seedTokenComponents = async (args: {
  eventId: number;
  tokens?: TokenQuantities;
  costUsd: string | null;
}) => {
  const t = args.tokens ?? {};
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
        usageEventId: args.eventId,
        component: c.component,
        quantity: String(c.quantity),
        unit: 'token',
        billable: c.billable,
        unitPrice: null,
        costUsd: args.costUsd,
        priceId: null,
      };
    })
  );
};

export const seedUsageEvent = async (opts: {
  projectInternalId: number;
  agentInternalId?: number | null;
  actorInternalId?: number | null;
  tokens?: TokenQuantities;
  costUsd?: string | null;
  createdAt?: Date;
  meterType?: string;
  source?: string | null;
  provider?: string;
  model?: string;
  componentCostUsd?: string | null;
}): Promise<UsageEventInstance> => {
  const event = await db.UsageEvent.create({
    projectId: opts.projectInternalId,
    agentId: opts.agentInternalId ?? null,
    actorId: opts.actorInternalId ?? null,
    meterType: opts.meterType ?? 'llm_tokens',
    source: opts.source ?? null,
    provider: opts.provider ?? 'ollama',
    model: opts.model ?? 'stub-model',
    costUsd: opts.costUsd ?? null,
    idempotencyKey: `${generatePublicId(PUBLIC_ID_PREFIXES.usageEvent)}:seed`,
  });
  await seedTokenComponents({
    eventId: (event as unknown as { id: number }).id,
    tokens: opts.tokens,
    costUsd: opts.componentCostUsd ?? null,
  });
  if (opts.createdAt) {
    await db.UsageEvent.update(
      { createdAt: opts.createdAt },
      { where: { id: (event as unknown as { id: number }).id }, silent: true }
    );
  }
  return event;
};

export const createQuotaRow = async (opts: {
  projectInternalId: number;
  scope: string;
  scopeRef?: string | null;
  metric: string;
  window?: string;
  limit: number;
  mode?: string;
  // Left null when absent — which is also what every quota row stored before
  // the column existed carries, so the default here doubles as the legacy case.
  onUnpriced?: string;
}): Promise<QuotaInstance> => {
  const quota = await db.Quota.create({
    projectId: opts.projectInternalId,
    scope: opts.scope,
    scopeRef: opts.scopeRef ?? null,
    metric: opts.metric,
    window: opts.window ?? 'calendar_month',
    limit: String(opts.limit),
    mode: opts.mode ?? 'enforce',
    onUnpriced: opts.onUnpriced ?? null,
  });
  return quota;
};
