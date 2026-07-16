import { db } from '../db';

// The metering write path lives in `usageRecording.ts`; re-exported here so the
// module's public surface (used by the generation lifecycle and tests) is
// unchanged. `usage.ts` owns the read path (list + receipt re-export).
export type {
  UsageAggregate,
  UsageAggregateGroup,
  UsageAggregateTotals,
  UsageGroupBy,
} from './usageAggregate';
export { aggregateUsage, USAGE_GROUP_BY } from './usageAggregate';
export type {
  UsageReceipt,
  UsageReceiptComponent,
  UsageReceiptLine,
  UsageReceiptMeterTypeTotal,
  UsageTotals,
} from './usageReceipt';
export { getReceipt, getRunReceipt, getRunUsageTotals } from './usageReceipt';
export type { UsageTokens } from './usageRecording';
export { extractUsageTokens, recordGenerationUsage } from './usageRecording';

export type PersistedUsageComponent = {
  component: string;
  quantity: number;
  unit: string;
  billable: boolean;
  unitPrice: number | null;
  costUsd: number | null;
  priceId: string | null;
};

export type PersistedUsageEvent = {
  id: string;
  projectId: string;
  runId: string | null;
  nodeId: string | null;
  agentId: string | null;
  generationId: string | null;
  traceId: string | null;
  aiProviderId: string | null;
  triggerId: string | null;
  actionId: string | null;
  meterType: string;
  provider: string;
  model: string;
  costUsd: number | null;
  components: PersistedUsageComponent[];
  createdAt: Date;
};

const assocPublicId = (
  assoc: { publicId: string } | null | undefined
): string | null => {
  return assoc?.publicId ?? null;
};

const mapComponent = (
  component: InstanceType<(typeof db)['UsageComponent']> & {
    price?: InstanceType<(typeof db)['PriceBook']> | null;
  }
): PersistedUsageComponent => {
  return {
    component: component.component,
    quantity: Number(component.quantity),
    unit: component.unit,
    billable: component.billable,
    unitPrice:
      component.unitPrice === null ? null : Number(component.unitPrice),
    costUsd: component.costUsd === null ? null : Number(component.costUsd),
    priceId: assocPublicId(component.price),
  };
};

const mapUsageEvent = (
  event: InstanceType<(typeof db)['UsageEvent']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agent?: InstanceType<(typeof db)['Agent']> | null;
    generation?: InstanceType<(typeof db)['Generation']> | null;
    run?: InstanceType<(typeof db)['OrchestrationRun']> | null;
    trace?: InstanceType<(typeof db)['Trace']> | null;
    aiProvider?: InstanceType<(typeof db)['AiProvider']> | null;
    components?: InstanceType<(typeof db)['UsageComponent']>[];
  }
): PersistedUsageEvent => {
  if (!event.project) {
    throw new Error('UsageEvent project association is required.');
  }
  return {
    id: event.publicId,
    projectId: event.project.publicId,
    runId: assocPublicId(event.run),
    nodeId: event.nodeId,
    agentId: assocPublicId(event.agent),
    generationId: assocPublicId(event.generation),
    traceId: assocPublicId(event.trace),
    aiProviderId: assocPublicId(event.aiProvider),
    triggerId: event.triggerId,
    actionId: event.actionId,
    meterType: event.meterType,
    provider: event.provider,
    model: event.model,
    costUsd: event.costUsd === null ? null : Number(event.costUsd),
    components: (event.components ?? []).map(mapComponent),
    createdAt: event.createdAt,
  };
};

// Resolves a project-scoped resource publicId (agent/generation/trace) to its
// internal id. Returns null when it does not exist in scope so the caller can
// yield an empty page instead of leaking cross-tenant rows.
const resolveScopedId = async (
  find: (where: {
    publicId: string;
    projectId?: number[];
  }) => Promise<{ id?: number } | null>,
  publicId: string,
  projectIds?: number[]
): Promise<number | null> => {
  const where: { publicId: string; projectId?: number[] } = { publicId };
  if (projectIds !== undefined) where.projectId = projectIds;
  const row = await find(where);
  return row?.id ?? null;
};

// Resolves agent/generation/trace publicId filters into `where` (mutating it).
// Returns false when a referenced resource does not exist in scope.
const applyUsageScopeFilters = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: Record<string, any>,
  args: {
    agentId?: string;
    generationId?: string;
    traceId?: string;
    projectIds?: number[];
  }
): Promise<boolean> => {
  if (args.agentId !== undefined) {
    const agentId = await resolveScopedId(
      (w) => {
        return db.Agent.findOne({ where: w });
      },
      args.agentId,
      args.projectIds
    );
    if (agentId === null) return false;
    where.agentId = agentId;
  }
  if (args.generationId !== undefined) {
    const generationId = await resolveScopedId(
      (w) => {
        return db.Generation.findOne({ where: w });
      },
      args.generationId,
      args.projectIds
    );
    if (generationId === null) return false;
    where.generationId = generationId;
  }
  if (args.traceId !== undefined) {
    const traceId = await resolveScopedId(
      (w) => {
        return db.Trace.findOne({ where: w });
      },
      args.traceId,
      args.projectIds
    );
    if (traceId === null) return false;
    where.traceId = traceId;
  }
  return true;
};

export const listUsageEvents = async (args: {
  projectIds?: number[];
  agentId?: string;
  generationId?: string;
  traceId?: string;
  triggerId?: string;
  actionId?: string;
  meterType?: string;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  const empty = { data: [], total: 0, limit, offset };

  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0) return empty;
    where.projectId = args.projectIds;
  }

  if (args.triggerId !== undefined) where.triggerId = args.triggerId;
  if (args.actionId !== undefined) where.actionId = args.actionId;
  if (args.meterType !== undefined) where.meterType = args.meterType;

  const resolved = await applyUsageScopeFilters(where, {
    agentId: args.agentId,
    generationId: args.generationId,
    traceId: args.traceId,
    projectIds: args.projectIds,
  });
  if (!resolved) return empty;

  const { count, rows } = await db.UsageEvent.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Agent, as: 'agent' },
      { model: db.Generation, as: 'generation' },
      { model: db.OrchestrationRun, as: 'run' },
      { model: db.Trace, as: 'trace' },
      { model: db.AiProvider, as: 'aiProvider' },
      {
        model: db.UsageComponent,
        as: 'components',
        include: [{ model: db.PriceBook, as: 'price' }],
      },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  return { data: rows.map(mapUsageEvent), total: count, limit, offset };
};
