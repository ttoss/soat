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

/**
 * A billable component carries a cost exactly when a price row covered it, so
 * a seeded event that is priced at the event level is priced at the component
 * level too — anything else is a shape the write path cannot produce, and the
 * pricing-gap signal reads components. `unpriced` names the billable
 * components a price row missed, which is how a *partly* priced event is
 * seeded: the event total is a real number and one dimension of it is not.
 */
const seedTokenComponents = async (args: {
  eventId: number;
  tokens?: TokenQuantities;
  costUsd: string | null;
  unpriced: Array<keyof TokenQuantities>;
}) => {
  const t = args.tokens ?? {};
  const comps = [
    {
      name: 'input',
      component: 'input_tokens',
      quantity: t.input ?? 0,
      billable: true,
    },
    {
      name: 'output',
      component: 'output_tokens',
      quantity: t.output ?? 0,
      billable: true,
    },
    {
      name: 'cached',
      component: 'cached_tokens',
      quantity: t.cached ?? 0,
      billable: true,
    },
    {
      name: 'reasoning',
      component: 'reasoning_tokens',
      quantity: t.reasoning ?? 0,
      billable: false,
    },
  ] as const;
  await db.UsageComponent.bulkCreate(
    comps.map((c) => {
      const priced = c.billable && !args.unpriced.includes(c.name);
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
        costUsd: priced ? args.costUsd : null,
        priceId: null,
      };
    })
  );
};

type SeedUsageEventOptions = {
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
  /** Per-billable-component cost. Defaults to the event's own, so a priced
   * event is priced all the way down. */
  componentCostUsd?: string | null;
  /** Billable components no price row covered, whatever the event total says. */
  unpricedComponents?: Array<keyof TokenQuantities>;
};

const eventAttributes = (opts: SeedUsageEventOptions) => {
  return {
    projectId: opts.projectInternalId,
    agentId: opts.agentInternalId ?? null,
    actorId: opts.actorInternalId ?? null,
    meterType: opts.meterType ?? 'llm_tokens',
    source: opts.source ?? null,
    provider: opts.provider ?? 'ollama',
    model: opts.model ?? 'stub-model',
    costUsd: opts.costUsd ?? null,
    idempotencyKey: `${generatePublicId(PUBLIC_ID_PREFIXES.usageEvent)}:seed`,
  };
};

export const seedUsageEvent = async (
  opts: SeedUsageEventOptions
): Promise<UsageEventInstance> => {
  const event = await db.UsageEvent.create(eventAttributes(opts));
  await seedTokenComponents({
    eventId: (event as unknown as { id: number }).id,
    tokens: opts.tokens,
    costUsd: opts.componentCostUsd ?? opts.costUsd ?? null,
    unpriced: opts.unpricedComponents ?? [],
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
  // Null means every meter, which is what a pre-column row carries too.
  meterType?: string;
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
    meterType: opts.meterType ?? null,
  });
  return quota;
};
