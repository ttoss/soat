import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import type { SoatEvent } from './eventBus';
import { emitEvent, onEvent, resolveProjectPublicId } from './eventBus';

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
  'run_failed' | 'guardrail_tripwire' | 'approval_expired' | 'manual';

/**
 * Default severity per kind, applied when a producer files without an explicit
 * severity. Keyed to actionability rather than raw "badness": a run that failed
 * after exhausting retries needs intervention (`critical`); a guardrail tripwire
 * is the guard working as designed and also feeds learned rules (`warning`); a
 * lapsed approval is a fail-safe missed SLA (`warning`).
 */
const DEFAULT_SEVERITY_BY_KIND: Record<ExceptionKind, ExceptionSeverity> = {
  run_failed: 'critical',
  guardrail_tripwire: 'warning',
  approval_expired: 'warning',
  manual: 'warning',
};

type ExceptionInstance = InstanceType<(typeof db)['ExceptionItem']> & {
  project?: InstanceType<(typeof db)['Project']> | null;
  acknowledgedByUser?: InstanceType<(typeof db)['User']> | null;
  resolvedByUser?: InstanceType<(typeof db)['User']> | null;
};

const isUniqueViolation = (error: unknown): boolean => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'SequelizeUniqueConstraintError'
  );
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

/**
 * Maps a persisted exception item to the plain, publicId-only API shape. The
 * internal `id` and the `*ByUserId` FK columns are never exposed — resolver
 * identity is surfaced via public IDs only.
 */
export const mapException = (instance: ExceptionInstance) => {
  return {
    id: instance.publicId,
    projectId: instance.project?.publicId,
    status: instance.status,
    severity: instance.severity,
    kind: instance.kind,
    title: instance.title,
    detail: instance.detail,
    occurrenceCount: instance.occurrenceCount,
    lastSeenAt: instance.lastSeenAt,
    runId: instance.runId,
    nodeId: instance.nodeId,
    agentId: instance.agentId,
    guardrailVersion: instance.guardrailVersion,
    acknowledgedBy: instance.acknowledgedByUser?.publicId ?? null,
    resolvedBy: instance.resolvedByUser?.publicId ?? null,
    resolutionNote: instance.resolutionNote,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

export type MappedException = ReturnType<typeof mapException>;

const emitExceptionEvent = async (args: {
  type: string;
  item: MappedException;
  projectId: number;
}): Promise<void> => {
  const projectPublicId = await resolveProjectPublicId({
    projectId: args.projectId,
  });
  emitEvent({
    type: args.type,
    projectId: args.projectId,
    projectPublicId,
    resourceType: 'exception',
    resourceId: args.item.id,
    data: { exception: args.item },
    timestamp: new Date().toISOString(),
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
  const withRefs = await db.ExceptionItem.findOne({
    where: { id: instance.id },
    include: buildIncludes(),
  });
  return mapException(withRefs!);
};

export type FileExceptionArgs = {
  projectId: number;
  kind: ExceptionKind;
  title: string;
  detail?: object | null;
  severity?: ExceptionSeverity;
  dedupKey?: string | null;
  runId?: string | null;
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
      runId: args.runId,
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
}): Promise<MappedException[]> => {
  const where: Record<string, unknown> = { projectId: args.projectIds };
  if (args.status) where.status = args.status;
  if (args.severity) where.severity = args.severity;
  if (args.kind) where.kind = args.kind;

  const items = await db.ExceptionItem.findAll({
    where,
    include: buildIncludes(),
    order: [['createdAt', 'DESC']],
  });
  return items.map(mapException);
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

// ── Producers (event-driven) ────────────────────────────────────────────────
//
// Exceptions are auto-filed by subscribing to events the platform already emits,
// so producers stay decoupled: an exhausted run and a lapsed approval reuse the
// existing `orchestration_runs.failed` / `approvals.expired` events with no
// change to those modules; a guardrail tripwire emits a dedicated
// `guardrail.tripwire` event. Every handler is fire-and-forget — a filing
// failure must never disturb the producer.

const asRecord = (value: unknown): Record<string, unknown> => {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
};

const asStringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

const fileRunFailedException = async (event: SoatEvent): Promise<void> => {
  const runId = event.resourceId;
  await fileException({
    projectId: event.projectId,
    kind: 'run_failed',
    title: `Orchestration run ${runId} failed`,
    detail: asRecord(event.data).error
      ? asRecord(asRecord(event.data).error)
      : null,
    runId,
    // One exception per failed run — a run reaches `failed` once.
    dedupKey: `run_failed:${runId}`,
  });
};

const fileApprovalExpiredException = async (
  event: SoatEvent
): Promise<void> => {
  const approval = asRecord(asRecord(event.data).approval);
  const approvalId = asStringOrNull(approval.id);
  await fileException({
    projectId: event.projectId,
    kind: 'approval_expired',
    title: `Approval ${approvalId ?? '(unknown)'} expired without a decision`,
    detail: { approvalId, toolId: asRecord(approval.proposedAction).toolId },
    runId: asStringOrNull(approval.runId),
    agentId: asStringOrNull(approval.agentId),
    dedupKey: approvalId ? `approval_expired:${approvalId}` : null,
  });
};

const fileGuardrailTripwireException = async (
  event: SoatEvent
): Promise<void> => {
  const data = asRecord(event.data);
  const runId = asStringOrNull(data.runId);
  const nodeId = asStringOrNull(data.nodeId);
  const generationId = asStringOrNull(data.generationId);
  const toolName = asStringOrNull(data.toolName) ?? event.resourceId;
  const guardrailVersion = asStringOrNull(data.guardrailVersion);
  // Fold repeated trips of the same guardrail on the same call site (a tool
  // node that trips every attempt, an agent looping) into one open item.
  const scope = runId ? `${runId}:${nodeId ?? ''}` : (generationId ?? '');
  await fileException({
    projectId: event.projectId,
    kind: 'guardrail_tripwire',
    title: `Guardrail tripwire aborted ${toolName}`,
    detail: {
      toolName,
      action: asStringOrNull(data.action),
      guardrailVersion,
    },
    runId,
    nodeId,
    agentId: asStringOrNull(data.agentId),
    guardrailVersion,
    dedupKey: `guardrail_tripwire:${scope}:${guardrailVersion ?? ''}`,
  });
};

const handleEvent = (event: SoatEvent): void => {
  const filers: Record<string, (e: SoatEvent) => Promise<void>> = {
    'orchestration_runs.failed': fileRunFailedException,
    'approvals.expired': fileApprovalExpiredException,
    'guardrail.tripwire': fileGuardrailTripwireException,
  };
  const filer = filers[event.type];
  if (!filer) return;
  filer(event).catch((error) => {
    log('handleEvent: failed to file exception for %s %o', event.type, error);
  });
};

/**
 * Subscribes the exceptions module to the platform event bus so failures and
 * anomalies auto-file. Wired once at startup from `app.ts`, mirroring the
 * webhook dispatcher.
 */
export const initializeExceptionsListener = (): void => {
  onEvent(handleEvent);
};

/**
 * Emits a `guardrail.tripwire` event the exceptions listener turns into a
 * `guardrail_tripwire` exception. Fire-and-forget from the guardrail dispatch
 * path — mirrors how audit records are persisted there.
 */
export const emitGuardrailTripwireEvent = (args: {
  projectId: number;
  projectPublicId: string;
  toolId: string | null;
  toolName: string;
  action: string;
  guardrailVersion: string | null;
  runId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  generationId?: string | null;
}): void => {
  emitEvent({
    type: 'guardrail.tripwire',
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    resourceType: 'guardrail',
    resourceId: args.toolId ?? args.toolName,
    data: {
      toolName: args.toolName,
      action: args.action,
      guardrailVersion: args.guardrailVersion,
      runId: args.runId ?? null,
      nodeId: args.nodeId ?? null,
      agentId: args.agentId ?? null,
      generationId: args.generationId ?? null,
    },
    timestamp: new Date().toISOString(),
  });
};
