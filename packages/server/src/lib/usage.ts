import { db } from '../db';
import { emptyPage, paginatedList } from './pagination';

// The metering write path is split across `usageRecording.ts` (the two
// `llm_tokens` writers), `usageTokenEvent.ts` (their shared pricing + persist
// primitives), and `usageComputeRecording.ts` (the `compute_execution` writer);
// all are re-exported here so the module's public surface (used by the
// generation lifecycle, the completion paths, and tests) is one import.
// `usage.ts` owns the read path (list + receipt re-export).
export type {
  UsageAggregate,
  UsageAggregateComponent,
  UsageAggregateGroup,
  UsageAggregateTotals,
  UsageGroupBy,
} from './usageAggregate';
export { aggregateUsage, USAGE_GROUP_BY } from './usageAggregate';
export { recordComputeUsage } from './usageComputeRecording';
export type {
  UsageReceipt,
  UsageReceiptComponent,
  UsageReceiptLine,
  UsageReceiptMeterTypeTotal,
  UsageTotals,
} from './usageReceipt';
export { getReceipt, getRunReceipt, getRunUsageTotals } from './usageReceipt';
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
    orchestration_run_id: assocPublicId(event.run),
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
    provider: event.provider,
    model: event.model,
    cost_usd: event.costUsd === null ? null : Number(event.costUsd),
    components: (event.components ?? []).map(mapComponent),
    created_at: event.createdAt,
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

type ScopedFilterArgs = {
  agentId?: string;
  generationId?: string;
  traceId?: string;
  actorId?: string;
  sessionId?: string;
};

// The publicId filters that resolve to an internal FK on the event, and the
// model each one resolves against. Adding a filter is one entry here.
const SCOPED_FILTERS: Array<{
  key: keyof ScopedFilterArgs;
  find: (where: {
    publicId: string;
    projectId?: number[];
  }) => Promise<{ id?: number } | null>;
}> = [
  {
    key: 'agentId',
    find: (w) => {
      return db.Agent.findOne({ where: w });
    },
  },
  {
    key: 'generationId',
    find: (w) => {
      return db.Generation.findOne({ where: w });
    },
  },
  {
    key: 'traceId',
    find: (w) => {
      return db.Trace.findOne({ where: w });
    },
  },
  {
    key: 'actorId',
    find: (w) => {
      return db.Actor.findOne({ where: w });
    },
  },
  {
    key: 'sessionId',
    find: (w) => {
      return db.Session.findOne({ where: w });
    },
  },
];

// Resolves the publicId filters into `where` (mutating it). Returns false when
// a referenced resource does not exist in scope, so the caller yields an empty
// page rather than silently dropping the filter and over-reporting.
const applyUsageScopeFilters = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: Record<string, any>,
  args: ScopedFilterArgs & { projectIds?: number[] }
): Promise<boolean> => {
  for (const filter of SCOPED_FILTERS) {
    const publicId = args[filter.key];
    if (publicId === undefined) continue;
    const resolved = await resolveScopedId(
      filter.find,
      publicId,
      args.projectIds
    );
    if (resolved === null) return false;
    where[filter.key] = resolved;
  }
  return true;
};

export const listUsageEvents = async (args: {
  projectIds?: number[];
  agentId?: string;
  generationId?: string;
  traceId?: string;
  actorId?: string;
  sessionId?: string;
  triggerId?: string;
  actionId?: string;
  meterType?: string;
  limit?: number;
  offset?: number;
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};

  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0) return emptyPage(args);
    where.projectId = args.projectIds;
  }

  if (args.triggerId !== undefined) where.triggerId = args.triggerId;
  if (args.actionId !== undefined) where.actionId = args.actionId;
  if (args.meterType !== undefined) where.meterType = args.meterType;

  const resolved = await applyUsageScopeFilters(where, {
    agentId: args.agentId,
    generationId: args.generationId,
    traceId: args.traceId,
    actorId: args.actorId,
    sessionId: args.sessionId,
    projectIds: args.projectIds,
  });
  if (!resolved) return emptyPage(args);

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.UsageEvent.findAndCountAll({
        where: Object.keys(where).length > 0 ? where : undefined,
        include: [
          { model: db.Project, as: 'project' },
          { model: db.Agent, as: 'agent' },
          { model: db.Generation, as: 'generation' },
          { model: db.OrchestrationRun, as: 'run' },
          { model: db.Trace, as: 'trace' },
          { model: db.Actor, as: 'actor' },
          { model: db.Session, as: 'session' },
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
    },
    map: mapUsageEvent,
  });
};
