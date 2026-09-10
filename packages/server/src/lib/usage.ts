import { db } from '../db';
import { emptyPage, paginatedList } from './pagination';
import type { ScopedIdResource } from './scopedIdFilters';
import { applyScopedIdFilters, resolveScopedIds } from './scopedIdFilters';
import { VALUE_NARROWING_KEYS } from './usageNarrowings';

// The write path is split across three modules and re-exported here, so the
// module's public surface is one import. This file owns the read path.
export type {
  UsageAggregate,
  UsageAggregateComponent,
  UsageAggregateFilters,
  UsageAggregateGroup,
  UsageAggregateTotals,
  UsageGroupBy,
  UsageNarrowings,
} from './usageAggregate';
export {
  aggregateUsage,
  rollUpUsageTotals,
  USAGE_GROUP_BY,
} from './usageAggregate';
export { recordComputeUsage } from './usageComputeRecording';
export type {
  UsageReceipt,
  UsageReceiptComponent,
  UsageReceiptLine,
  UsageReceiptMeterTypeTotal,
  UsageTotals,
} from './usageReceipt';
export {
  getOrchestrationRunReceipt,
  getOrchestrationRunUsageRollups,
  getReceipt,
} from './usageReceipt';
export type { CompletionUsageSource } from './usageRecording';
export { recordCompletionUsage, recordGenerationUsage } from './usageRecording';
export type { PersistedUsageThreshold } from './usageThresholds';
export {
  createThreshold,
  deleteThreshold,
  evaluateProjectThresholds,
  getThreshold,
  listThresholds,
  USAGE_THRESHOLD_CROSSED_EVENT,
  USAGE_THRESHOLD_METRICS,
  USAGE_THRESHOLD_WINDOWS,
} from './usageThresholds';
export type { UsageTokens } from './usageTokenEvent';
export { extractUsageTokens } from './usageTokenEvent';

export type PersistedUsageComponent = {
  component: string;
  quantity: number;
  unit: string;
  billable: boolean;
  unit_price: number | null;
  cost_usd: number | null;
  price_id: string | null;
};

export type PersistedUsageEvent = {
  id: string;
  project_id: string;
  orchestration_run_id: string | null;
  node_id: string | null;
  agent_id: string | null;
  generation_id: string | null;
  trace_id: string | null;
  actor_id: string | null;
  session_id: string | null;
  ai_provider_id: string | null;
  trigger_id: string | null;
  action_id: string | null;
  meter_type: string;
  // The workload behind the spend (`eval`, `eval_judge`, `chat`, a memory pass);
  // null for ordinary agent traffic. This is what makes verification spend
  // separable from the traffic serving real users.
  source: string | null;
  provider: string;
  model: string;
  cost_usd: number | null;
  components: PersistedUsageComponent[];
  created_at: Date;
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
    unit_price:
      component.unitPrice === null ? null : Number(component.unitPrice),
    cost_usd: component.costUsd === null ? null : Number(component.costUsd),
    price_id: assocPublicId(component.price),
  };
};

const mapUsageEvent = (
  event: InstanceType<(typeof db)['UsageEvent']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agent?: InstanceType<(typeof db)['Agent']> | null;
    generation?: InstanceType<(typeof db)['Generation']> | null;
    run?: InstanceType<(typeof db)['OrchestrationRun']> | null;
    trace?: InstanceType<(typeof db)['Trace']> | null;
    actor?: InstanceType<(typeof db)['Actor']> | null;
    session?: InstanceType<(typeof db)['Session']> | null;
    aiProvider?: InstanceType<(typeof db)['AiProvider']> | null;
    components?: InstanceType<(typeof db)['UsageComponent']>[];
  }
): PersistedUsageEvent => {
  if (!event.project) {
    throw new Error('UsageEvent project association is required.');
  }
  return {
    id: event.publicId,
    project_id: event.project.publicId,
    orchestration_run_id: assocPublicId(event.orchestrationRun),
    node_id: event.nodeId,
    agent_id: assocPublicId(event.agent),
    generation_id: assocPublicId(event.generation),
    trace_id: assocPublicId(event.trace),
    actor_id: assocPublicId(event.actor),
    session_id: assocPublicId(event.session),
    ai_provider_id: assocPublicId(event.aiProvider),
    trigger_id: event.triggerId,
    action_id: event.actionId,
    meter_type: event.meterType,
    source: event.source ?? null,
    provider: event.provider,
    model: event.model,
    cost_usd: event.costUsd === null ? null : Number(event.costUsd),
    components: (event.components ?? []).map(mapComponent),
    created_at: event.createdAt,
  };
};

type ScopedFilterArgs = {
  agentId?: string;
  generationId?: string;
  traceId?: string;
  actorId?: string;
  sessionId?: string;
  aiProviderId?: string;
  orchestrationRunId?: string;
};

// The publicId filters that resolve to an internal FK on the event, and the
// table each one resolves against. Adding a filter is one entry here.
// `orchestrationId` is not among them: the event carries no such column, so it
// narrows through the run association instead (see `eventIncludes`).
const SCOPED_FILTERS: ReadonlyArray<{
  key: keyof ScopedFilterArgs;
  resource: ScopedIdResource;
}> = [
  { key: 'agentId', resource: 'agent' },
  { key: 'generationId', resource: 'generation' },
  { key: 'traceId', resource: 'trace' },
  { key: 'actorId', resource: 'actor' },
  { key: 'sessionId', resource: 'session' },
  { key: 'aiProviderId', resource: 'aiProvider' },
  { key: 'orchestrationRunId', resource: 'orchestrationRun' },
];

// Resolves the publicId filters into `where` (mutating it). Returns false when
// a referenced resource does not exist in scope, so the caller yields an empty
// page rather than silently dropping the filter and over-reporting.
const applyUsageScopeFilters = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: Record<string, any>,
  args: ScopedFilterArgs & { projectIds?: number[] }
): Promise<boolean> => {
  return applyScopedIdFilters({
    where,
    filters: SCOPED_FILTERS.map((filter) => {
      return {
        key: filter.key,
        resource: filter.resource,
        publicId: args[filter.key],
      };
    }),
    ...(args.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
  });
};

// The associations every returned event hydrates. `orchestrationId` is the one
// narrowing with no column on the event — the orchestration is the run's — so
// it is applied by making the run join required rather than by a subquery.
const eventIncludes = (args: { orchestrationId?: number }) => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Agent, as: 'agent' },
    { model: db.Generation, as: 'generation' },
    {
      model: db.OrchestrationRun,
      as: 'orchestrationRun',
      ...(args.orchestrationId === undefined
        ? {}
        : {
            where: { orchestrationId: args.orchestrationId },
            required: true,
          }),
    },
    { model: db.Trace, as: 'trace' },
    { model: db.Actor, as: 'actor' },
    { model: db.Session, as: 'session' },
    { model: db.AiProvider, as: 'aiProvider' },
    {
      model: db.UsageComponent,
      as: 'components',
      include: [{ model: db.PriceBook, as: 'price' }],
    },
  ];
};

export const listUsageEvents = async (args: {
  projectIds?: number[];
  agentId?: string;
  generationId?: string;
  traceId?: string;
  actorId?: string;
  sessionId?: string;
  aiProviderId?: string;
  orchestrationRunId?: string;
  orchestrationId?: string;
  triggerId?: string;
  actionId?: string;
  meterType?: string;
  model?: string;
  source?: string;
  limit?: number;
  offset?: number;
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};

  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0) return emptyPage(args);
    where.projectId = args.projectIds;
  }

  for (const key of VALUE_NARROWING_KEYS) {
    const value = args[key];
    if (value !== undefined) where[key] = value;
  }

  const resolved = await applyUsageScopeFilters(where, {
    agentId: args.agentId,
    generationId: args.generationId,
    traceId: args.traceId,
    actorId: args.actorId,
    sessionId: args.sessionId,
    aiProviderId: args.aiProviderId,
    orchestrationRunId: args.orchestrationRunId,
    projectIds: args.projectIds,
  });
  if (!resolved) return emptyPage(args);

  const orchestration = await resolveScopedIds({
    filters: [
      {
        key: 'orchestrationId' as const,
        resource: 'orchestration' as const,
        publicId: args.orchestrationId,
      },
    ],
    ...(args.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
  });
  if (!orchestration) return emptyPage(args);

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.UsageEvent.findAndCountAll({
        where: Object.keys(where).length > 0 ? where : undefined,
        include: eventIncludes(orchestration),
        order: [['createdAt', 'DESC']],
        limit,
        offset,
        distinct: true,
      });
    },
    map: mapUsageEvent,
  });
};
