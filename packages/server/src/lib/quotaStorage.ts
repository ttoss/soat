/**
 * The `storage_bytes` stock cap: what bounds how much a project may store
 * (#1249).
 *
 * A stock in a flow engine shares almost none of the windowed machinery. There
 * is no `quota_window_counters` row to increment, no window key, no
 * `resets_at`, and no `Retry-After` — the aggregate *is* the footprint, and
 * only deleting content clears a breach. What is shared is the two things a
 * caller and an operator read: `quotaBreachError` builds the response body, and
 * `fireQuotaExceeded` fires the one `quota.exceeded` webhook (plus, in
 * `monitor` mode, the audit entry that is the whole point of a dry run).
 *
 * **Where the cap acts, and what it deliberately does not reach.** The guard
 * sits on the caller-facing corpus writes — file upload and create, document
 * create, document ingest and re-ingest, memory-entry create — and on nothing
 * that a generation drives from the inside. Every conversation message is a
 * `Document` with its own chunks and embeddings, and the `write_memory` tool,
 * memory extraction and an orchestration's memory node all write entries
 * mid-turn: a refusal there would leave a turn half persisted, which is the
 * one thing the enforcement points above are chosen to avoid. So the cap bounds
 * the ingest surface a tenant drives deliberately, and `monitor`-mode data is
 * what should settle whether that is enough.
 */

import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { type QuotaBreach, quotaBreachError } from './quotaBreach';
import { fireQuotaExceeded } from './quotaEvents';
import { lastSnapshotStoredBytes } from './usageStorage';

const log = createDebug('soat:quotas');

type QuotaInstance = InstanceType<(typeof db)['Quota']>;

/**
 * The measurement a verdict was read from, as a `fireQuotaExceeded` key. A
 * stock has no window, so the UTC day of the snapshot stands in: the webhook
 * and the monitor-mode audit entry then re-fire once per fresh measurement
 * while a project stays over, rather than once ever (a `'current'` key would
 * never change, so a project that breached, deleted, and breached again would
 * be silent the second time).
 */
const measurementKey = (measuredAt: Date): string => {
  return measuredAt.toISOString().slice(0, 10);
};

/**
 * What one cap is compared against: the last snapshot plus this request's own
 * delta. A project the sweep has never metered contributes nothing measurable,
 * so the delta stands alone — which still refuses a single upload larger than
 * the whole cap.
 */
const measuredFootprint = async (args: {
  projectId: number;
  addedBytes: number;
}): Promise<{ currentBytes: number; measuredAt: Date }> => {
  const snapshot = await lastSnapshotStoredBytes({
    projectId: args.projectId,
  });
  log(
    'measuredFootprint: project=%d snapshotBytes=%d addedBytes=%d',
    args.projectId,
    snapshot?.bytes ?? 0,
    args.addedBytes
  );
  return {
    currentBytes: (snapshot?.bytes ?? 0) + args.addedBytes,
    measuredAt: snapshot?.measuredAt ?? new Date(),
  };
};

// Fires `quota.exceeded` once per measurement in both modes, and returns the
// breach only for `enforce` — a `monitor` breach webhooks and audits without
// blocking, here as everywhere.
const evaluateStorageQuota = async (args: {
  quota: QuotaInstance;
  currentBytes: number;
  measuredAt: Date;
  now: Date;
}): Promise<QuotaBreach | null> => {
  const { quota, currentBytes } = args;
  const limit = Number(quota.limit);

  // The delta is included, so what is refused is the write that would take the
  // footprint past the cap — a write landing exactly on it is admitted, as
  // `requests` admits the request that reaches its limit.
  if (currentBytes <= limit) return null;

  await fireQuotaExceeded({
    quota,
    windowKey: measurementKey(args.measuredAt),
    observedValue: currentBytes,
    now: args.now,
  });

  if (quota.mode !== 'enforce') return null;

  return {
    quotaId: quota.publicId,
    scope: quota.scope,
    scopeRef: quota.scopeRef,
    metric: quota.metric,
    window: quota.window,
    limit,
    reason: 'storage_exceeded',
    currentBytes,
  };
};

/**
 * Evaluates a project's `storage_bytes` quotas against the last snapshot plus
 * the bytes this request would add. Returns the breach to refuse with, or
 * `null` when the write is admitted.
 *
 * A project with no such quota costs one indexed `quotas` read and nothing
 * else — the snapshot is only read once a cap exists to compare it against.
 */
export const evaluateStorageQuotas = async (args: {
  projectId: number;
  addedBytes: number;
}): Promise<QuotaBreach | null> => {
  const quotas = (await db.Quota.findAll({
    where: { projectId: args.projectId, metric: 'storage_bytes' },
  })) as QuotaInstance[];

  if (quotas.length === 0) return null;

  const now = new Date();
  const { currentBytes, measuredAt } = await measuredFootprint(args);

  const breaches: QuotaBreach[] = [];
  for (const quota of quotas) {
    const breach = await evaluateStorageQuota({
      quota,
      currentBytes,
      measuredAt,
      now,
    });
    if (breach) breaches.push(breach);
  }

  // Every storage quota is project-scoped, so there is no scope to rank
  // between: the first breach is as specific as any of them.
  return breaches[0] ?? null;
};

/**
 * Refuses a corpus write whose project is over its `storage_bytes` cap.
 *
 * Fails **open** on infrastructure error, exactly as the generation gate does: a
 * quota is cost control, not authorization, so a day of unbounded growth beats
 * refusing every upload on a DB blip. A `DomainError` — the refusal itself —
 * is re-thrown rather than swallowed.
 */
export const assertStorageQuota = async (args: {
  projectId: number;
  addedBytes: number;
}): Promise<void> => {
  let breach: QuotaBreach | null = null;
  try {
    breach = await evaluateStorageQuotas(args);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    log('assertStorageQuota: failing open %O', error);
    return;
  }
  if (breach) throw quotaBreachError(breach);
};

/** Byte length of caller-supplied text, as the corpus will store it. */
export const contentBytes = (content: string | undefined | null): number => {
  return content ? Buffer.byteLength(content, 'utf8') : 0;
};
