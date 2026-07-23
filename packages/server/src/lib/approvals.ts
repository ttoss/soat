/* eslint-disable max-lines */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { paginatedList, type PaginatedResult } from './pagination';

const log = createDebug('soat:approvals');

/**
 * Event type names emitted by the approvals module. Webhook subscriptions match
 * these by exact name or the `approvals.*` prefix.
 */
export const APPROVAL_EVENT_TYPES = {
  created: 'approvals.created',
  approved: 'approvals.approved',
  rejected: 'approvals.rejected',
  expired: 'approvals.expired',
} as const;

type ApprovalInstance = InstanceType<(typeof db)['ApprovalItem']> & {
  project?: InstanceType<(typeof db)['Project']> | null;
  orchestrationRun?: InstanceType<(typeof db)['OrchestrationRun']> | null;
  resolvedByUser?: InstanceType<(typeof db)['User']> | null;
};

// A Sequelize unique-constraint violation surfaces as an error whose `name` is
// `SequelizeUniqueConstraintError` — matched by name so no Sequelize error
// class needs importing here.
const isUniqueViolation = (error: unknown): boolean => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'SequelizeUniqueConstraintError'
  );
};

// Built lazily inside each query: `db.*` models are only populated after the
// database initializes, so referencing them at module load time would be
// undefined.
const buildIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.OrchestrationRun, as: 'orchestrationRun' },
    { model: db.User, as: 'resolvedByUser' },
  ];
};

/**
 * Maps a persisted approval item to the plain, publicId-only shape returned by
 * the API. The internal `id`, `orchestrationRunId`, and `resolvedByUserId`
 * columns are never exposed — provenance is surfaced via public IDs only.
 */
export const mapApproval = (instance: ApprovalInstance) => {
  return {
    id: instance.publicId,
    projectId: instance.project?.publicId,
    origin: instance.origin,
    status: instance.status,
    proposedAction: instance.proposedAction,
    reasoning: instance.reasoning,
    evidence: instance.evidence,
    predictedImpact: instance.predictedImpact,
    expiresAt: instance.expiresAt,
    dedupKey: instance.dedupKey,
    runId: instance.orchestrationRun?.publicId ?? null,
    nodeId: instance.nodeId,
    generationId: instance.generationId,
    sessionId: instance.sessionId,
    agentId: instance.agentId,
    taskId: instance.taskId,
    taskTransition: instance.taskTransition,
    knowledgeVersion: instance.knowledgeVersion,
    policyVersion: instance.policyVersion,
    resolvedBy: instance.resolvedByUser?.publicId ?? null,
    resolutionReason: instance.resolutionReason,
    editedArguments: instance.editedArguments,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

export type MappedApproval = ReturnType<typeof mapApproval>;

/**
 * The producer-agnostic decision artifact (§6 of the PRD). The `approval`
 * orchestration node consumes it as its node result; a tool-call continuation
 * generation consumes it as the tool result. Identical shape for both — no
 * consumer branches on origin.
 */
export type DecisionOutput = {
  decision: 'approved' | 'rejected' | 'expired';
  approvalId: string;
  resolvedBy: string | null;
  editedArgs: object | null;
  reason: string | null;
  result: object | null;
};

const buildDecisionOutput = (item: MappedApproval): DecisionOutput => {
  return {
    decision: item.status as 'approved' | 'rejected' | 'expired',
    approvalId: item.id,
    resolvedBy: item.resolvedBy,
    editedArgs: item.editedArguments ?? null,
    // On approval the executed tool output belongs here. Actual execution of
    // the (frozen or edited) action at resolution time is wired in with the
    // producer that consumes it; until then the decision carries no result.
    result: null,
    reason: item.resolutionReason,
  };
};

/**
 * A producer's resumption callback (§1 of the PRD). Producers register how to
 * resume their suspended execution context when an item resolves; the approvals
 * module invokes it on approve/reject/expiry without importing the producer, so
 * the dependency points one way (producer → approvals).
 */
export type ApprovalResumeHandler = (args: {
  item: MappedApproval;
  decision: DecisionOutput;
}) => Promise<void>;

const resumeHandlers: ApprovalResumeHandler[] = [];

export const registerApprovalResumeHandler = (
  handler: ApprovalResumeHandler
): void => {
  resumeHandlers.push(handler);
};

/**
 * Invokes every registered resumption handler for a resolved item. Handlers are
 * isolated: one throwing is logged and swallowed so a producer-side failure
 * never corrupts the resolution response (the decision is already persisted; a
 * parked run can be recovered via the run's resume endpoint). Each handler
 * decides for itself whether the item concerns it (by `origin`/provenance).
 */
const notifyResume = async (
  item: MappedApproval,
  decision: DecisionOutput
): Promise<void> => {
  for (const handler of resumeHandlers) {
    try {
      await handler({ item, decision });
    } catch (error) {
      log('notifyResume: handler failed id=%s %o', item.id, error);
    }
  }
};

const emitApprovalEvent = async (args: {
  type: string;
  item: MappedApproval;
  projectId: number;
}): Promise<void> => {
  const projectPublicId = await resolveProjectPublicId({
    projectId: args.projectId,
  });
  emitEvent({
    type: args.type,
    projectId: args.projectId,
    projectPublicId,
    resourceType: 'approval',
    resourceId: args.item.id,
    data: { approval: args.item },
    timestamp: new Date().toISOString(),
  });
};

// Returns the still-pending item matching a dedup key in a project, or null.
// The partial unique index on `dedup_key WHERE status = 'pending'` guarantees at
// most one, so this is the fast path (and the race-resolution look-up) for §3.
const findPendingByDedupKey = async (args: {
  projectId: number;
  dedupKey: string;
}): Promise<ApprovalInstance | null> => {
  return db.ApprovalItem.findOne({
    where: {
      projectId: args.projectId,
      dedupKey: args.dedupKey,
      status: 'pending',
    },
    include: buildIncludes(),
  });
};

const findApprovalOrThrow = async (id: string): Promise<ApprovalInstance> => {
  const item = await db.ApprovalItem.findOne({
    where: { publicId: id },
    include: buildIncludes(),
  });
  if (!item) {
    throw new DomainError('APPROVAL_NOT_FOUND', `Approval '${id}' not found.`);
  }
  return item;
};

type EmitApprovalArgs = {
  projectId: number;
  origin?: 'node' | 'tool_call' | 'task_transition';
  proposedAction: { toolId: string; action?: string; arguments: object } | null;
  reasoning?: string | null;
  evidence?: object | null;
  predictedImpact?: string | null;
  expiresInSeconds: number;
  dedupKey?: string | null;
  orchestrationRunId?: number | null;
  nodeId?: string | null;
  generationId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  taskId?: string | null;
  taskTransition?: string | null;
  knowledgeVersion?: string | null;
  policyVersion?: string | null;
};

// Inserts the row, or — on a dedup unique-constraint race — resolves the pending
// winner a concurrent emit created. Optional fields pass through as-is:
// `undefined` falls back to each column's default or null (allowNull).
const insertApprovalItem = async (
  args: EmitApprovalArgs
): Promise<{ instance: ApprovalInstance } | { winner: MappedApproval }> => {
  const expiresAt = new Date(Date.now() + args.expiresInSeconds * 1000);
  try {
    const instance = await db.ApprovalItem.create({
      projectId: args.projectId,
      origin: args.origin,
      proposedAction: args.proposedAction,
      reasoning: args.reasoning,
      evidence: args.evidence,
      predictedImpact: args.predictedImpact,
      expiresAt,
      dedupKey: args.dedupKey,
      orchestrationRunId: args.orchestrationRunId,
      nodeId: args.nodeId,
      generationId: args.generationId,
      sessionId: args.sessionId,
      agentId: args.agentId,
      taskId: args.taskId,
      taskTransition: args.taskTransition,
      knowledgeVersion: args.knowledgeVersion,
      policyVersion: args.policyVersion,
    });
    return { instance };
  } catch (error) {
    // A concurrent emit won the partial unique index on
    // `dedup_key WHERE status = 'pending'`. Return that winner rather than
    // surfacing the constraint error — the retrying agent gets the existing item.
    if (args.dedupKey && isUniqueViolation(error)) {
      const winner = await findPendingByDedupKey({
        projectId: args.projectId,
        dedupKey: args.dedupKey,
      });
      if (winner) {
        log('emitApproval: dedup race resolved id=%s', winner.publicId);
        return { winner: mapApproval(winner) };
      }
    }
    throw error;
  }
};

/**
 * Creates an approval item, freezing the proposed action and its evidence at
 * emit time, and emits `approvals.created`. This is the sole way items enter
 * the queue — there is no public create endpoint (§10). Producers (the
 * `approval` node, tool-call interception, an approval-gated task transition)
 * call this and then park their own execution context.
 */
export const emitApproval = async (
  args: EmitApprovalArgs
): Promise<MappedApproval> => {
  log(
    'emitApproval: projectId=%d origin=%s toolId=%s expiresIn=%ds',
    args.projectId,
    args.origin ?? 'node',
    args.proposedAction?.toolId ?? '(none)',
    args.expiresInSeconds
  );

  // Dedup (§3 Phase 2): while a matching proposal is still pending, a
  // re-proposal returns the existing item instead of filing a second.
  if (args.dedupKey) {
    const existing = await findPendingByDedupKey({
      projectId: args.projectId,
      dedupKey: args.dedupKey,
    });
    if (existing) {
      log('emitApproval: dedup hit id=%s', existing.publicId);
      return mapApproval(existing);
    }
  }

  const created = await insertApprovalItem(args);
  // Dedup race backstop returned the pending winner directly (already mapped).
  if ('winner' in created) return created.winner;

  const withRefs = await db.ApprovalItem.findOne({
    where: { id: created.instance.id },
    include: buildIncludes(),
  });
  const item = mapApproval(withRefs!);
  log('emitApproval: created id=%s', item.id);
  await emitApprovalEvent({
    type: APPROVAL_EVENT_TYPES.created,
    item,
    projectId: args.projectId,
  });
  return item;
};

export const listApprovals = async (args: {
  projectIds: number[];
  status?: string;
  origin?: string;
  expiresBefore?: Date;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedApproval>> => {
  const where: Record<string, unknown> = { projectId: args.projectIds };
  if (args.status) where.status = args.status;
  if (args.origin) where.origin = args.origin;
  if (args.expiresBefore) where.expiresAt = { [Op.lte]: args.expiresBefore };

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.ApprovalItem.findAndCountAll({
        where,
        include: buildIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapApproval,
  });
};

export const getApproval = async (args: {
  id: string;
}): Promise<MappedApproval> => {
  const item = await findApprovalOrThrow(args.id);
  return mapApproval(item);
};

/**
 * Server-side expiry gate. Atomically flips a still-`pending` item whose
 * `expiresAt` has passed to `expired` and emits `approvals.expired`. The
 * guarded `UPDATE` (status still `pending`) makes this safe to call from both
 * the sweeper and the resolution path — whichever wins, the item expires
 * exactly once and can never execute late.
 *
 * Returns the mapped item when this call performed the expiry, else `null`
 * (already resolved by a competing caller).
 */
export const expireApprovalIfDue = async (args: {
  id: string;
  now?: Date;
}): Promise<MappedApproval | null> => {
  const now = args.now ?? new Date();
  const [claimed] = await db.ApprovalItem.update(
    { status: 'expired' },
    {
      where: {
        publicId: args.id,
        status: 'pending',
        expiresAt: { [Op.lte]: now },
      },
    }
  );
  if (claimed === 0) return null;

  const item = await findApprovalOrThrow(args.id);
  const mapped = mapApproval(item);
  log('expireApprovalIfDue: expired id=%s', mapped.id);
  await emitApprovalEvent({
    type: APPROVAL_EVENT_TYPES.expired,
    item: mapped,
    projectId: item.projectId,
  });
  await notifyResume(mapped, buildDecisionOutput(mapped));
  return mapped;
};

/**
 * Emits `approvals.expired` for an item the sweeper has already flipped to
 * `expired` via its atomic claim. Kept separate from {@link expireApprovalIfDue}
 * (which claims *and* emits) so the sweeper's guarded-UPDATE claim stays the
 * single point that decides the winner across overlapping ticks and workers.
 */
export const announceApprovalExpired = async (args: {
  id: string;
}): Promise<void> => {
  const item = await findApprovalOrThrow(args.id);
  const mapped = mapApproval(item);
  log('announceApprovalExpired: id=%s', mapped.id);
  await emitApprovalEvent({
    type: APPROVAL_EVENT_TYPES.expired,
    item: mapped,
    projectId: item.projectId,
  });
  await notifyResume(mapped, buildDecisionOutput(mapped));
};

const assertResolvable = (item: ApprovalInstance): void => {
  if (item.status !== 'pending') {
    throw new DomainError(
      'APPROVAL_ALREADY_RESOLVED',
      `Approval '${item.publicId}' is already ${item.status}.`
    );
  }
};

/**
 * Closes the sweep-vs-resolve race: if the item is already past `expiresAt`,
 * expire it and throw `APPROVAL_EXPIRED` so it can never execute late.
 */
const assertNotExpiredOrExpire = async (
  item: ApprovalInstance,
  verb: string
): Promise<void> => {
  if (item.expiresAt.getTime() <= Date.now()) {
    await expireApprovalIfDue({ id: item.publicId });
    throw new DomainError(
      'APPROVAL_EXPIRED',
      `Approval '${item.publicId}' has expired and cannot be ${verb}.`
    );
  }
};

const assertValidEditedArgs = (editedArguments?: object | null): void => {
  if (editedArguments === undefined || editedArguments === null) return;
  if (typeof editedArguments !== 'object' || Array.isArray(editedArguments)) {
    throw new DomainError(
      'APPROVAL_INVALID_EDIT',
      'edited arguments must be a JSON object.'
    );
  }
};

/**
 * Re-fetches the resolved item with all provenance includes, emits the given
 * lifecycle event, and returns the mapped item plus its decision output.
 */
const finalizeResolution = async (args: {
  id: string;
  projectId: number;
  eventType: string;
}): Promise<{ item: MappedApproval; decision: DecisionOutput }> => {
  const refreshed = await findApprovalOrThrow(args.id);
  const mapped = mapApproval(refreshed);
  const decision = buildDecisionOutput(mapped);
  await emitApprovalEvent({
    type: args.eventType,
    item: mapped,
    projectId: args.projectId,
  });
  await notifyResume(mapped, decision);
  return { item: mapped, decision };
};

/**
 * Approves an item, optionally replacing the proposed arguments
 * (edit-then-approve). Re-checks expiry at decision time to close the
 * sweep-vs-approve race: an item past `expiresAt` is expired and rejected with
 * `APPROVAL_EXPIRED` rather than executed. Edited arguments must be a JSON
 * object; deeper validation against the tool's input schema happens when the
 * approved action is executed.
 */
export const approveApproval = async (args: {
  id: string;
  editedArguments?: object | null;
  resolvedByUserId: number;
}): Promise<{ item: MappedApproval; decision: DecisionOutput }> => {
  log(
    'approveApproval: id=%s edited=%s',
    args.id,
    args.editedArguments != null
  );
  const item = await findApprovalOrThrow(args.id);
  assertResolvable(item);
  await assertNotExpiredOrExpire(item, 'approved');
  assertValidEditedArgs(args.editedArguments);

  item.status = 'approved';
  item.resolvedByUserId = args.resolvedByUserId;
  item.editedArguments = args.editedArguments ?? null;
  await item.save();

  return finalizeResolution({
    id: args.id,
    projectId: item.projectId,
    eventType: APPROVAL_EVENT_TYPES.approved,
  });
};

/**
 * Rejects an item. A reason is required and preserved on the item — it (and any
 * edit diff) is the raw material of the learned-rules feedback loop.
 */
export const rejectApproval = async (args: {
  id: string;
  reason: string;
  resolvedByUserId: number;
}): Promise<{ item: MappedApproval; decision: DecisionOutput }> => {
  log('rejectApproval: id=%s', args.id);
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError(
      'APPROVAL_REASON_REQUIRED',
      'A reason is required when rejecting an approval.'
    );
  }

  const item = await findApprovalOrThrow(args.id);
  assertResolvable(item);
  await assertNotExpiredOrExpire(item, 'rejected');

  item.status = 'rejected';
  item.resolvedByUserId = args.resolvedByUserId;
  item.resolutionReason = args.reason;
  await item.save();

  return finalizeResolution({
    id: args.id,
    projectId: item.projectId,
    eventType: APPROVAL_EVENT_TYPES.rejected,
  });
};
