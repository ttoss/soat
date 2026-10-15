import { db } from '../db';
import { emptyPage, paginatedList } from './pagination';
import type { RecordedIdKey } from './usageNarrowings';
import {
  RECORDED_ID_COLUMNS,
  resolveIdNarrowings,
  VALUE_NARROWING_KEYS,
} from './usageNarrowings';

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
export { extractUsageTokens } from './usageTokenEvent';
export type { UsageTokens, UsageTotals } from './usageTotals';

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
  tool_id: string | null;
  publisher_project_id: string | null;
  // What an embedding event embedded; null on a query and every other meter.
  document_id: string | null;
  memory_store_id: string | null;
  // `ok` | `error` | `timeout` on a `tool_execution` event; null otherwise.
  outcome: string | null;
  meter_type: string;
  // The workload behind the spend (`eval`, `eval_judge`, `chat`, a memory store pass);
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

const recorded = (publicId: string | null | undefined): string | null => {
  return publicId ?? null;
};

// Every attribution id is the public id the event recorded beside its FK
// (`USAGE_EVENT_DURABLE_IDS`), not the FK's join: deleting an entity nulls the
// FK, and its events must keep naming it.
const mapUsageEvent = (
  event: InstanceType<(typeof db)['UsageEvent']> & {
    project?: InstanceType<(typeof db)['Project']>;
    components?: InstanceType<(typeof db)['UsageComponent']>[];
  }
): PersistedUsageEvent => {
  if (!event.project) {
    throw new Error('UsageEvent project association is required.');
  }
  return {
    id: event.publicId,
    project_id: event.project.publicId,
    orchestration_run_id: recorded(event.orchestrationRunPublicId),
    node_id: event.nodeId,
    agent_id: recorded(event.agentPublicId),
    generation_id: recorded(event.generationPublicId),
    trace_id: recorded(event.tracePublicId),
    actor_id: recorded(event.actorPublicId),
    session_id: recorded(event.sessionPublicId),
    ai_provider_id: recorded(event.aiProviderPublicId),
    trigger_id: event.triggerId,
    action_id: event.actionId,
    tool_id: recorded(event.toolPublicId),
    publisher_project_id: recorded(event.publisherProjectPublicId),
    document_id: recorded(event.documentPublicId),
    memory_store_id: recorded(event.memoryStorePublicId),
    outcome: event.outcome ?? null,
    meter_type: event.meterType,
    source: event.source ?? null,
    provider: event.provider,
    model: event.model,
    cost_usd: event.costUsd === null ? null : Number(event.costUsd),
    components: (event.components ?? []).map(mapComponent),
    created_at: event.createdAt,
  };
};

// The associations every returned event hydrates. `orchestrationId` is the one
// narrowing with no column on the event — the orchestration is the run's — so
// it is applied by joining the run, required, rather than by a subquery.
const eventIncludes = (args: { orchestrationId?: number }) => {
  return [
    { model: db.Project, as: 'project' },
    ...(args.orchestrationId === undefined
      ? []
      : [
          {
            model: db.OrchestrationRun,
            as: 'orchestrationRun',
            attributes: [],
            where: { orchestrationId: args.orchestrationId },
            required: true,
          },
        ]),
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
  toolId?: string;
  publisherProjectId?: string;
  triggerId?: string;
  actionId?: string;
  outcome?: string;
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

  const resolved = await resolveIdNarrowings({
    narrowings: args,
    ...(args.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
  });
  if (!resolved) return emptyPage(args);

  const { orchestrationId, ...ids } = resolved.ids;
  Object.assign(where, ids);
  for (const [key, publicId] of Object.entries(resolved.recordedIds) as Array<
    [RecordedIdKey, string]
  >) {
    where[RECORDED_ID_COLUMNS[key].attribute] = publicId;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.UsageEvent.findAndCountAll({
        where: Object.keys(where).length > 0 ? where : undefined,
        include: eventIncludes({ orchestrationId }),
        order,
        limit,
        offset,
        distinct: true,
      });
    },
    map: mapUsageEvent,
  });
};
