import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { emitResourceEvent, resolveProjectPublicId } from './eventBus';
import { paginatedList, type PaginatedResult } from './pagination';
import { isPlainObject } from './plainObject';
import { camelToSnakeKey, convertKeys } from './resource-inputs/normalizers';
import { makeResourceAccessor } from './resourceAccessor';
import type { SoatEventTypeFor } from './soatEvents';
import { isUniqueViolation } from './uniqueViolation';

const log = createDebug('soat:exceptions');

/**
 * Event type names emitted by the exceptions module. Webhook subscriptions
 * match these by exact name or the `exceptions.*` prefix.
 */
export const EXCEPTION_EVENT_TYPES = {
  created: 'exceptions.created',
} as const;

export type ExceptionSeverity = 'info' | 'warning' | 'critical';
export type ExceptionKind =
  | 'run_failed'
  | 'guardrail_tripwire'
  | 'approval_expired'
  | 'quota_unpriced'
  | 'event_trigger_loop'
  | 'chain_limit'
  | 'manual';

/**
 * Default severity per kind, applied when a producer files without an explicit
 * severity. Keyed to actionability rather than raw "badness": a run that failed
 * after exhausting retries needs intervention (`critical`); a guardrail tripwire
 * is the guard working as designed and also feeds learned rules (`warning`); a
 * lapsed approval is a fail-safe missed SLA (`warning`); a cost cap that cannot
 * be evaluated is a control silently protecting nothing — it needs a config fix,
 * not an incident response (`warning`); an event trigger that refused to extend
 * a causal chain, and a continuation chain that spent its generation budget, are
 * loops running unattended — the guard worked, and the wiring still needs a
 * human (`warning`).
 */
const DEFAULT_SEVERITY_BY_KIND: Record<ExceptionKind, ExceptionSeverity> = {
  run_failed: 'critical',
  guardrail_tripwire: 'warning',
  approval_expired: 'warning',
  quota_unpriced: 'warning',
  event_trigger_loop: 'warning',
  chain_limit: 'warning',
  manual: 'warning',
};

type ExceptionInstance = InstanceType<(typeof db)['ExceptionItem']> & {
  project?: InstanceType<(typeof db)['Project']> | null;
  acknowledgedByUser?: InstanceType<(typeof db)['User']> | null;
  resolvedByUser?: InstanceType<(typeof db)['User']> | null;
};

// Built lazily inside each query: `db.*` models are only populated after the
// database initializes.
const buildIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.User, as: 'acknowledgedByUser' },
    { model: db.User, as: 'resolvedByUser' },
  ];
};

const exceptionItems = makeResourceAccessor<ExceptionInstance>({
  model: () => {
    return db.ExceptionItem;
  },
  includes: buildIncludes,
  label: 'Exception',
  errorCode: 'EXCEPTION_NOT_FOUND',
});

/**
 * Converts `detail`'s own top-level keys from camelCase to snake_case
 * without recursing into nested values. Producers (fileApprovalExpiredException,
 * fileGuardrailTripwireException, quotaEvents, guardrailEvaluationRecord's
 * `route_to_approval` detail) build `detail` entirely from server-owned
 * fields (`approvalId`, `toolId`, `toolName`, `guardrailVersion`, `quotaId`,
 * ...), so the top level is always safe to rename. A *nested* bag like
 * `contextSnapshot` (spread in verbatim from a guardrail evaluation record)
 * is itself an author-authored value one level down — its own inner keys
 * must never be touched, which is exactly what a shallow (non-recursive)
 * conversion guarantees.
 */
const mapExceptionDetail = (
  detail: unknown
): Record<string, unknown> | null => {
  if (!isPlainObject(detail)) return (detail as null) ?? null;
  return convertKeys(detail, camelToSnakeKey);
};

/**
 * Maps a persisted exception item to the plain, publicId-only API shape. The
 * internal `id` and the `*ByUserId` FK columns are never exposed — resolver
 * identity is surfaced via public IDs only.
 */
export const mapException = (instance: ExceptionInstance) => {
  return {
    id: instance.publicId,
    project_id: instance.project?.publicId,
    status: instance.status,
    severity: instance.severity,
    kind: instance.kind,
    title: instance.title,
    detail: mapExceptionDetail(instance.detail),
    occurrence_count: instance.occurrenceCount,
    last_seen_at: instance.lastSeenAt,
    orchestration_run_id: instance.orchestrationRunId,
    node_id: instance.nodeId,
    agent_id: instance.agentId,
    guardrail_version: instance.guardrailVersion,
    acknowledged_by: instance.acknowledgedByUser?.publicId ?? null,
    resolved_by: instance.resolvedByUser?.publicId ?? null,
    resolution_note: instance.resolutionNote,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

export type MappedException = ReturnType<typeof mapException>;

const emitExceptionEvent = async (args: {
  type: SoatEventTypeFor<'exception'>;
  item: MappedException;
  projectId: number;
}): Promise<void> => {
  const projectPublicId = await resolveProjectPublicId({
    projectId: args.projectId,
  });
  emitResourceEvent({
    type: args.type,
    projectId: args.projectId,
    projectPublicId,
    resourceType: 'exception',
    resourceId: args.item.id,
    data: { exception: args.item },
  });
};

// Returns the still-open item matching a dedup key in a project, or null. The
// partial unique index on `dedup_key WHERE status = 'open'` guarantees at most
// one, so this is both the fast path and the race-resolution lookup.
const findOpenByDedupKey = async (args: {
  projectId: number;
  dedupKey: string;
}): Promise<ExceptionInstance | null> => {
  return db.ExceptionItem.findOne({
    where: {
      projectId: args.projectId,
      dedupKey: args.dedupKey,
      status: 'open',
    },
    include: buildIncludes(),
  });
};

const findExceptionOrThrow = async (id: string): Promise<ExceptionInstance> => {
  const item = await db.ExceptionItem.findOne({
    where: { publicId: id },
    include: buildIncludes(),
  });
  if (!item) {
    throw new DomainError(
      'EXCEPTION_NOT_FOUND',
      `Exception '${id}' not found.`
    );
  }
  return item;
};

const reload = async (
  instance: ExceptionInstance
): Promise<MappedException> => {
  return mapException(await exceptionItems.reload(instance));
};

export type FileExceptionArgs = {
  projectId: number;
  kind: ExceptionKind;
  title: string;
  detail?: object | null;
  severity?: ExceptionSeverity;
  dedupKey?: string | null;
  orchestrationRunId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  guardrailVersion?: string | null;
};

// Folds a recurrence into the existing open item: bumps the occurrence count and
// last-seen timestamp. No event — the exception already exists and callers only
// want a fresh signal on the first occurrence.
const recordRecurrence = async (
  existing: ExceptionInstance
): Promise<MappedException> => {
  existing.occurrenceCount += 1;
  existing.lastSeenAt = new Date();
  await existing.save();
  log(
    'fileException: dedup hit id=%s occurrences=%d',
    existing.publicId,
    existing.occurrenceCount
  );
  return reload(existing);
};

const insertException = async (
  args: FileExceptionArgs
): Promise<{ instance: ExceptionInstance } | { winner: MappedException }> => {
  try {
    // Nullable columns left `undefined` persist as null (Sequelize skips them),
    // so no `?? null` fan-out is needed here.
    const instance = await db.ExceptionItem.create({
      projectId: args.projectId,
      kind: args.kind,
      severity: args.severity ?? DEFAULT_SEVERITY_BY_KIND[args.kind],
      title: args.title,
      detail: args.detail,
      dedupKey: args.dedupKey,
      lastSeenAt: new Date(),
      orchestrationRunId: args.orchestrationRunId,
      nodeId: args.nodeId,
      agentId: args.agentId,
      guardrailVersion: args.guardrailVersion,
    });
    return { instance };
  } catch (error) {
    // A concurrent file won the partial unique index; fold into that winner.
    if (args.dedupKey && isUniqueViolation(error)) {
      const winner = await findOpenByDedupKey({
        projectId: args.projectId,
        dedupKey: args.dedupKey,
      });
      if (winner) return { winner: await recordRecurrence(winner) };
    }
    throw error;
  }
};

/**
 * Files an exception — the sole way items enter the queue; there is no public
 * create endpoint (auto-filed by producers, or `manual`). Repeated identical
 * failures (same `dedupKey`) fold into one open item with an incrementing
 * `occurrenceCount` instead of filing duplicates, and only the first occurrence
 * emits `exceptions.created`.
 */
export const fileException = async (
  args: FileExceptionArgs
): Promise<MappedException> => {
  log(
    'fileException: projectId=%d kind=%s dedupKey=%s',
    args.projectId,
    args.kind,
    args.dedupKey ?? '(none)'
  );

  if (args.dedupKey) {
    const existing = await findOpenByDedupKey({
      projectId: args.projectId,
      dedupKey: args.dedupKey,
    });
    if (existing) return recordRecurrence(existing);
  }

  const created = await insertException(args);
  if ('winner' in created) return created.winner;

  const item = await reload(created.instance);
  log('fileException: created id=%s', item.id);
  await emitExceptionEvent({
    type: EXCEPTION_EVENT_TYPES.created,
    item,
    projectId: args.projectId,
  });
  return item;
};

export const listExceptions = async (args: {
  projectIds: number[];
  status?: string;
  severity?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedException>> => {
  const where: Record<string, unknown> = { projectId: args.projectIds };
  if (args.status) where.status = args.status;
  if (args.severity) where.severity = args.severity;
  if (args.kind) where.kind = args.kind;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.ExceptionItem.findAndCountAll({
        where,
        include: buildIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapException,
  });
};

export const getException = async (args: {
  id: string;
}): Promise<MappedException> => {
  const item = await findExceptionOrThrow(args.id);
  return mapException(item);
};

// A resolved exception is terminal — acknowledging or resolving it again is a
// no-op error, mirroring the approvals "already resolved" contract.
const assertNotResolved = (item: ExceptionInstance): void => {
  if (item.status === 'resolved') {
    throw new DomainError(
      'EXCEPTION_ALREADY_RESOLVED',
      `Exception '${item.publicId}' is already resolved.`
    );
  }
};

/**
 * Moves an item to `acknowledged` ("someone is on it"), recording who. A no-op
 * that returns the item unchanged when it is already acknowledged; rejected when
 * already resolved.
 */
export const acknowledgeException = async (args: {
  id: string;
  userId: number;
}): Promise<MappedException> => {
  log('acknowledgeException: id=%s', args.id);
  const item = await findExceptionOrThrow(args.id);
  assertNotResolved(item);
  if (item.status !== 'acknowledged') {
    item.status = 'acknowledged';
    item.acknowledgedByUserId = args.userId;
    await item.save();
  }
  return reload(item);
};

/**
 * Moves an item to `resolved` ("fixed"), recording who and an optional note.
 * Rejected when already resolved.
 */
export const resolveException = async (args: {
  id: string;
  userId: number;
  note?: string | null;
}): Promise<MappedException> => {
  log('resolveException: id=%s', args.id);
  const item = await findExceptionOrThrow(args.id);
  assertNotResolved(item);
  item.status = 'resolved';
  item.resolvedByUserId = args.userId;
  item.resolutionNote = args.note ?? null;
  await item.save();
  return reload(item);
};

// The event-driven auto-filing producers live in `exceptionAutoFile.ts`, split
// out to stay under this file's `max-lines` limit (#1130).
