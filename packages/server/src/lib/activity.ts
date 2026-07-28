import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { APPROVAL_EVENT_TYPES } from './approvals';
import type { SoatEvent } from './eventBus';
import { onEvent } from './eventBus';
import { EXCEPTION_EVENT_TYPES } from './exceptions';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './pagination';
import {
  camelToSnakeKey,
  convertKeys,
  isPlainObject,
} from './resource-inputs/normalizers';

const log = createDebug('soat:activity');

export type ActivitySeverity = 'info' | 'warning' | 'critical';
export type ActivityKind =
  | 'action_executed'
  | 'approval_resolved'
  | 'exception_created'
  | 'schedule_fired';

/**
 * Default severity per kind, applied when a producer emits without an
 * explicit severity. `exception_created` defaults to `warning` because an
 * exception was already filed (an anomaly, by definition); the other three
 * kinds are routine autonomous operation.
 */
const DEFAULT_SEVERITY_BY_KIND: Record<ActivityKind, ActivitySeverity> = {
  action_executed: 'info',
  approval_resolved: 'info',
  exception_created: 'warning',
  schedule_fired: 'info',
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
    const instance = await db.ActivityEntry.create({
      projectId: args.projectId,
      kind: args.kind,
      severity: args.severity ?? DEFAULT_SEVERITY_BY_KIND[args.kind],
      summary: args.summary,
      detail: args.detail,
      orchestrationRunId: args.orchestrationRunId,
      agentId: args.agentId,
      refId: args.refId,
    });
    const mapped = await reload(instance.id as number);
    log('emitActivityEntry: created id=%s', mapped.id);
    return mapped;
  } catch (error) {
    log('emitActivityEntry: failed kind=%s %o', args.kind, error);
    return null;
  }
};

/**
 * Counts the project's autonomously executed actions in a rolling window ending
 * now — the value behind the guardrail `soat.activity.actions_1h` /
 * `actions_24h` context keys, so a guard can cap how many actions an agent takes
 * per window. Scoped to `action_executed`: the other kinds record what the
 * platform did *about* an action (an approval resolved, an exception filed, a
 * schedule fired), not an action an agent took, so counting them would inflate
 * the rate a ceiling is written against. Exported for the guardrail context
 * provider (`guardrailContext.ts`).
 */
export const windowedActionCount = async (args: {
  projectId: number;
  start: Date;
}): Promise<number> => {
  log(
    'windowedActionCount: projectId=%d start=%s',
    args.projectId,
    args.start.toISOString()
  );
  return db.ActivityEntry.count({
    where: {
      projectId: args.projectId,
      kind: 'action_executed',
      createdAt: { [Op.gte]: args.start },
    },
  });
};

type ActivityCursor = { createdAt: string; publicId: string };

/**
 * Opaque `base64url(createdAt|publicId)` keyset cursor. Only ever encodes
 * public, already-exposed fields (never the internal integer PK — see the
 * postgresdb "Public ID" rule), so the token is safe to hand back to a caller
 * verbatim.
 */
const encodeCursor = (entry: { createdAt: Date; publicId: string }): string => {
  return Buffer.from(
    `${entry.createdAt.toISOString()}|${entry.publicId}`,
    'utf8'
  ).toString('base64url');
};

const decodeCursor = (cursor: string): ActivityCursor => {
  const invalid = (): never => {
    throw new DomainError(
      'ACTIVITY_INVALID_CURSOR',
      `Cursor '${cursor}' is invalid.`
    );
  };

  // `Buffer.from(..., 'base64url')` never throws for any input string — it
  // decodes whatever bytes it can, so validity is checked structurally below
  // rather than by catching a decode error that can't occur.
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');

  const separatorIndex = decoded.indexOf('|');
  if (separatorIndex < 0) return invalid();

  const createdAt = decoded.slice(0, separatorIndex);
  const publicId = decoded.slice(separatorIndex + 1);
  if (!createdAt || !publicId || Number.isNaN(Date.parse(createdAt))) {
    return invalid();
  }

  return { createdAt, publicId };
};

const resolveActivityLimit = (limit?: number): number => {
  const raw = limit ?? DEFAULT_LIST_LIMIT;
  return Math.min(
    Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT
  );
};

export type ListActivityResult = {
  data: MappedActivityEntry[];
  next_cursor: string | null;
};

/**
 * Cursor-paginated (keyset, not offset) — the PRD calls for cursor pagination
 * specifically, unlike this codebase's other list endpoints, because the feed
 * is append-only and high-volume: an offset page shifts under a fast-moving
 * feed, a keyset cursor never does.
 */
export const listActivity = async (args: {
  projectIds: number[];
  kind?: string;
  severity?: string;
  cursor?: string;
  limit?: number;
}): Promise<ListActivityResult> => {
  const limit = resolveActivityLimit(args.limit);
  const where: Record<string, unknown> = { projectId: args.projectIds };
  if (args.kind) where.kind = args.kind;
  if (args.severity) where.severity = args.severity;

  let finalWhere: Record<string, unknown> = where;
  if (args.cursor) {
    const { createdAt, publicId } = decodeCursor(args.cursor);
    finalWhere = {
      [Op.and]: [
        where,
        {
          [Op.or]: [
            { createdAt: { [Op.lt]: new Date(createdAt) } },
            {
              createdAt: new Date(createdAt),
              publicId: { [Op.lt]: publicId },
            },
          ],
        },
      ],
    };
  }

  const rows = await db.ActivityEntry.findAll({
    where: finalWhere,
    include: buildIncludes(),
    order: [
      ['createdAt', 'DESC'],
      ['publicId', 'DESC'],
    ],
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const data = pageRows.map((row) => {
    return mapActivityEntry(row as ActivityInstance);
  });
  const last = pageRows[pageRows.length - 1] as ActivityInstance | undefined;
  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: last.createdAt, publicId: last.publicId })
      : null;

  return { data, next_cursor: nextCursor };
};

// ── Producers (event-driven) ────────────────────────────────────────────────
//
// approval_resolved and exception_created auto-record by subscribing to
// events the platform already emits — no change to the approvals/exceptions
// modules. schedule_fired is emitted directly from `triggerScheduler.ts`
// (no existing event to subscribe to there). action_executed is emitted from
// two call sites: the orchestration tool-node executor (run-scoped) and the
// agent tool resolver via `agentToolActivity.ts` (agent-scoped). Every handler
// here is fire-and-forget — a recording failure must never disturb the producer.

const asRecord = (value: unknown): Record<string, unknown> => {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
};

const asStringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

const fileApprovalResolvedActivity = async (
  event: SoatEvent
): Promise<void> => {
  const approval = asRecord(event.data).approval;
  if (!approval) return;
  const record = asRecord(approval);
  const approvalId = asStringOrNull(record.id);
  const status = asStringOrNull(record.status) ?? 'resolved';
  await emitActivityEntry({
    projectId: event.projectId,
    kind: 'approval_resolved',
    summary: `Approval ${approvalId ?? '(unknown)'} ${status}`,
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

const fileExceptionCreatedActivity = async (
  event: SoatEvent
): Promise<void> => {
  const exception = asRecord(event.data).exception;
  if (!exception) return;
  const record = asRecord(exception);
  const exceptionId = asStringOrNull(record.id);
  await emitActivityEntry({
    projectId: event.projectId,
    kind: 'exception_created',
    summary: `Exception ${exceptionId ?? '(unknown)'} filed (${
      asStringOrNull(record.kind) ?? 'unknown'
    })`,
    detail: {
      exceptionKind: record.kind,
      severity: record.severity,
    },
    orchestrationRunId: asStringOrNull(record.orchestration_run_id),
    agentId: asStringOrNull(record.agent_id),
    refId: exceptionId,
  });
};

// No `.catch()` here: every handler below terminates in `emitActivityEntry`,
// which already swallows and logs its own failures (see its docstring) and
// never rejects, so there is nothing left for this dispatcher to catch.
const handleEvent = (event: SoatEvent): void => {
  const handlers: Record<string, (e: SoatEvent) => Promise<void>> = {
    [APPROVAL_EVENT_TYPES.approved]: fileApprovalResolvedActivity,
    [APPROVAL_EVENT_TYPES.rejected]: fileApprovalResolvedActivity,
    [EXCEPTION_EVENT_TYPES.created]: fileExceptionCreatedActivity,
  };
  const handler = handlers[event.type];
  if (!handler) return;
  void handler(event);
};

/**
 * Subscribes the activity module to the platform event bus so approval
 * resolutions and exception filings auto-record. Wired once at startup from
 * `app.ts`, mirroring the exceptions listener.
 */
export const initializeActivityListener = (): void => {
  onEvent(handleEvent);
};
