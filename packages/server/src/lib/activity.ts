import createDebug from 'debug';
import { db } from 'src/db';

import { APPROVAL_EVENT_TYPES } from './approvals';
import type { SoatEvent } from './eventBus';
import { onEvent, recordDroppedEvent } from './eventBus';
import { EXCEPTION_EVENT_TYPES } from './exceptions';
import { type Page, type PageRequest, paginatedList } from './pagination';
import { isPlainObject } from './plainObject';
import { camelToSnakeKey, convertKeys } from './resource-inputs/normalizers';
import { isSoatEventType, type SoatEventType } from './soatEvents';
import { retryTransient } from './transientRetry';

const log = createDebug('soat:activity');

export const ACTIVITY_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type ActivitySeverity = (typeof ACTIVITY_SEVERITIES)[number];

export const ACTIVITY_KINDS = [
  'action_executed',
  'approval_created',
  'approval_resolved',
  'exception_created',
  'schedule_fired',
  'share_cap_exceeded',
  'share_resumed',
  'share_revoked',
  'share_suspended',
  'tool_resolution_failed',
  'usage_quantity_invalid',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * Default severity per kind, applied when a producer emits without an
 * explicit severity. `exception_created` defaults to `warning` because an
 * exception was already filed (an anomaly, by definition), and
 * `tool_resolution_failed` because the turn ran without tools it was configured
 * to have, and a suspended or revoked share because something the project
 * accepted stopped being granted or refused a call over its cap, and an
 * unreadable price quantity because the call went unpriced; the other kinds are routine autonomous
 * operation, an approval waiting on a human included.
 */
const DEFAULT_SEVERITY_BY_KIND: Record<ActivityKind, ActivitySeverity> = {
  action_executed: 'info',
  approval_created: 'info',
  approval_resolved: 'info',
  exception_created: 'warning',
  schedule_fired: 'info',
  share_cap_exceeded: 'warning',
  share_resumed: 'info',
  share_revoked: 'warning',
  share_suspended: 'warning',
  tool_resolution_failed: 'warning',
  usage_quantity_invalid: 'warning',
};

type ActivityInstance = InstanceType<(typeof db)['ActivityEntry']> & {
  project?: InstanceType<(typeof db)['Project']> | null;
};

// Shallow (non-recursive) conversion, matching `mapExceptionDetail`: `detail`'s
// top level is server-owned (tool id, args digest, policy version), but a
// nested bag may carry author-authored keys that must never be touched.
const mapActivityDetail = (detail: unknown): Record<string, unknown> | null => {
  if (!isPlainObject(detail)) return (detail as null) ?? null;
  return convertKeys(detail, camelToSnakeKey);
};

export const mapActivityEntry = (instance: ActivityInstance) => {
  return {
    id: instance.publicId,
    project_id: instance.project?.publicId,
    kind: instance.kind,
    severity: instance.severity,
    summary: instance.summary,
    detail: mapActivityDetail(instance.detail),
    orchestration_run_id: instance.orchestrationRunId,
    agent_id: instance.agentId,
    generation_id: instance.generationId,
    ref_id: instance.refId,
    created_at: instance.createdAt,
  };
};

export type MappedActivityEntry = ReturnType<typeof mapActivityEntry>;

const buildIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

const reload = async (id: number): Promise<MappedActivityEntry> => {
  const withRefs = await db.ActivityEntry.findOne({
    where: { id },
    include: buildIncludes(),
  });
  return mapActivityEntry(withRefs!);
};

export type EmitActivityEntryArgs = {
  projectId: number;
  kind: ActivityKind;
  summary: string;
  detail?: object | null;
  severity?: ActivitySeverity;
  orchestrationRunId?: string | null;
  agentId?: string | null;
  generationId?: string | null;
  refId?: string | null;
};

/**
 * The single shared write hook every producer calls — mirrors the audit log's
 * "auditing never blocks or fails the request it describes": any write
 * failure is logged and swallowed here, never thrown, so an activity-write
 * hiccup can never break the autonomous action it merely records.
 */
export const emitActivityEntry = async (
  args: EmitActivityEntryArgs
): Promise<MappedActivityEntry | null> => {
  log('emitActivityEntry: projectId=%d kind=%s', args.projectId, args.kind);
  try {
    const instance = await retryTransient({
      label: 'emitActivityEntry.create',
      operation: () => {
        return db.ActivityEntry.create({
          projectId: args.projectId,
          kind: args.kind,
          severity: args.severity ?? DEFAULT_SEVERITY_BY_KIND[args.kind],
          summary: args.summary,
          detail: args.detail,
          orchestrationRunId: args.orchestrationRunId,
          agentId: args.agentId,
          generationId: args.generationId,
          refId: args.refId,
        });
      },
    });
    const mapped = await reload(instance.id as number);
    log('emitActivityEntry: created id=%s', mapped.id);
    return mapped;
  } catch (error) {
    // Guardrails gate on this table, so a swallowed failure silently loosens
    // the limit the entry was supposed to count against. Still returns
    // `null` for the fire-and-forget caller, but the loss is counted.
    recordDroppedEvent({
      stage: 'activity_write',
      type: args.kind,
      resourceId: args.refId ?? '',
      error,
    });
    return null;
  }
};

/**
 * Every filter is a conjunction, matching what `kind` and `severity` already
 * mean together: an entry carries one agent, one generation and one run, so a
 * caller naming two of them is asking for the rows where both hold.
 */
/** What narrows a feed read: the scope, and the filters a caller may add. */
export type ActivityFilters = {
  projectIds: number[];
  kind?: ActivityKind;
  severity?: ActivitySeverity;
  agentId?: string;
  generationId?: string;
  orchestrationRunId?: string;
};

/**
 * The `where` those filters compile to. One expression for the feed and its
 * export, so a filter narrows both the same way.
 */
export const buildActivityWhere = (
  filters: ActivityFilters
): Record<string, unknown> => {
  const where: Record<string, unknown> = { projectId: filters.projectIds };
  if (filters.kind) where.kind = filters.kind;
  if (filters.severity) where.severity = filters.severity;
  if (filters.agentId) where.agentId = filters.agentId;
  if (filters.generationId) where.generationId = filters.generationId;
  if (filters.orchestrationRunId) {
    where.orchestrationRunId = filters.orchestrationRunId;
  }
  return where;
};

/** The feed, newest first. */
export const listActivity = async (
  args: ActivityFilters & PageRequest
): Promise<Page<MappedActivityEntry>> => {
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: {
      projectIds: args.projectIds,
      kind: args.kind,
      severity: args.severity,
      agentId: args.agentId,
      generationId: args.generationId,
      orchestrationRunId: args.orchestrationRunId,
    },
    where: buildActivityWhere(args),
    order: [['createdAt', 'DESC']],
    query: ({ where, limit, order }) => {
      return db.ActivityEntry.findAll({
        where,
        include: buildIncludes(),
        order,
        limit,
      });
    },
    map: (row) => {
      return mapActivityEntry(row as ActivityInstance);
    },
  });
};

// Every handler here is fire-and-forget: a recording failure must never disturb
// the producer.

const asRecord = (value: unknown): Record<string, unknown> => {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
};

const asStringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

/**
 * Narrows an event's untyped severity to this module's vocabulary, which
 * `ExceptionItem` deliberately shares. Returns `undefined` for anything else so
 * the caller falls back to {@link DEFAULT_SEVERITY_BY_KIND} rather than writing
 * a value the column's enum would reject.
 */
const asSeverityOrUndefined = (
  value: unknown
): ActivitySeverity | undefined => {
  return value === 'info' || value === 'warning' || value === 'critical'
    ? value
    : undefined;
};

const fileApprovalActivity = async (args: {
  event: SoatEvent;
  kind: 'approval_created' | 'approval_resolved';
  summarize: (approvalId: string | null, status: string) => string;
}): Promise<void> => {
  const record = args.event.data;
  const approvalId = asStringOrNull(record.id);
  const status =
    asStringOrNull(record.status) ??
    (args.kind === 'approval_created' ? 'pending' : 'resolved');
  await emitActivityEntry({
    projectId: args.event.projectId,
    kind: args.kind,
    summary: args.summarize(approvalId, status),
    detail: {
      status,
      toolId: asRecord(record.proposed_action).tool_id,
      policyVersion: record.policy_version,
    },
    orchestrationRunId: asStringOrNull(record.orchestration_run_id),
    agentId: asStringOrNull(record.agent_id),
    refId: approvalId,
  });
};

// Filed on creation so a pending approval is discoverable from the feed the
// way a created exception is.
const fileApprovalCreatedActivity = async (event: SoatEvent): Promise<void> => {
  await fileApprovalActivity({
    event,
    kind: 'approval_created',
    summarize: (approvalId) => {
      return `Approval ${approvalId ?? '(unknown)'} awaiting decision`;
    },
  });
};

const fileApprovalResolvedActivity = async (
  event: SoatEvent
): Promise<void> => {
  await fileApprovalActivity({
    event,
    kind: 'approval_resolved',
    summarize: (approvalId, status) => {
      return `Approval ${approvalId ?? '(unknown)'} ${status}`;
    },
  });
};

const fileExceptionCreatedActivity = async (
  event: SoatEvent
): Promise<void> => {
  const record = event.data;
  const exceptionId = asStringOrNull(record.id);
  await emitActivityEntry({
    projectId: event.projectId,
    kind: 'exception_created',
    summary: `Exception ${exceptionId ?? '(unknown)'} filed (${
      asStringOrNull(record.kind) ?? 'unknown'
    })`,
    // Inherit the exception's own severity: defaulting to this kind's
    // `warning` would understate the worst thing the feed records, leaving
    // `critical` unreachable through any producer.
    severity: asSeverityOrUndefined(record.severity),
    detail: {
      exceptionKind: record.kind,
      severity: record.severity,
    },
    orchestrationRunId: asStringOrNull(record.orchestration_run_id),
    agentId: asStringOrNull(record.agent_id),
    refId: exceptionId,
  });
};

/**
 * The events this module records, keyed by name. A `Map` rather than an object
 * literal so the keys stay typed as registered event names on both sides: the
 * subscription below is derived from them, and a renamed event fails to compile
 * here instead of quietly never matching.
 */
const ACTIVITY_HANDLERS = new Map<
  SoatEventType,
  (event: SoatEvent) => Promise<void>
>([
  [APPROVAL_EVENT_TYPES.created, fileApprovalCreatedActivity],
  [APPROVAL_EVENT_TYPES.approved, fileApprovalResolvedActivity],
  [APPROVAL_EVENT_TYPES.rejected, fileApprovalResolvedActivity],
  [EXCEPTION_EVENT_TYPES.created, fileExceptionCreatedActivity],
]);

// No `.catch()` here: every handler above terminates in `emitActivityEntry`,
// which already swallows and logs its own failures (see its docstring) and
// never rejects, so there is nothing left for this dispatcher to catch.
const handleEvent = (event: SoatEvent): void => {
  const handler = isSoatEventType(event.type)
    ? ACTIVITY_HANDLERS.get(event.type)
    : undefined;
  if (!handler) return;
  void handler(event);
};

/**
 * Subscribes the activity module to the platform event bus so approval
 * resolutions and exception filings auto-record. Wired once at startup from
 * `app.ts`, mirroring the exceptions listener.
 */
export const initializeActivityListener = (): void => {
  onEvent({ types: [...ACTIVITY_HANDLERS.keys()], handler: handleEvent });
};
