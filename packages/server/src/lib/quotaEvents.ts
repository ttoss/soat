import createDebug from 'debug';

import type { db } from '../db';
import { enqueueAuditWrite } from './auditQueue';
import type { PricingCoverage } from './costEnforceability';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { fileException } from './exceptions';

const log = createDebug('soat:quotas');

// Fired on the first breach within a window, in both modes: a `monitor` quota
// fires this and nothing else, an `enforce` one fires it alongside the 429.
export const QUOTA_EXCEEDED_EVENT = 'quota.exceeded';

type QuotaInstance = InstanceType<(typeof db)['Quota']>;

/**
 * Files a `quota_unpriced` exception for a `cost_usd` quota whose window metered
 * usage no price row covered.
 *
 * Such a cap aggregates less than was actually spent, so it under-enforces or —
 * when nothing at all was priced — can never breach: the cap looks healthy
 * through the API while protecting a fraction of what it claims to. That is the
 * one case where a quota fails *open* silently, so it is surfaced for triage
 * rather than logged. The exceptions queue is the right home — it already
 * carries severity, an `exceptions.created` webhook, and an acknowledge/resolve
 * lifecycle.
 *
 * **A partly-priced window files the same item as a blacked-out one** (#1228).
 * The fix is identical — price the rows in `unpricedRows` — and the refusal is
 * the only thing the two shapes differ on, so a separate kind would split one
 * degraded cap across two triage items and halve the occurrence count that says
 * how many generations ran under it.
 *
 * Deduped on the quota (not the window): "this cap is not measuring what it
 * caps" is one issue to triage, and the occurrence count then reads as how many
 * generations ran under it. Once resolved, a later recurrence files a fresh
 * item.
 */
export const reportUnpricedCostQuota = async (args: {
  quota: QuotaInstance;
  coverage: PricingCoverage;
}): Promise<void> => {
  const { quota, coverage } = args;

  log(
    'reportUnpricedCostQuota: quota=%s window=%s metered=%d unpricedEvents=%d unpricedRows=%d',
    quota.publicId,
    quota.window,
    coverage.meteredEventCount,
    coverage.unpricedEventCount,
    coverage.unpricedRows.length
  );

  await fileException({
    projectId: quota.projectId,
    kind: 'quota_unpriced',
    title: `Cost quota ${quota.publicId} cannot be enforced: the window metered usage no price row covered`,
    dedupKey: `quota_unpriced:${quota.publicId}`,
    detail: {
      quotaId: quota.publicId,
      metric: quota.metric,
      scope: quota.scope,
      scopeRef: quota.scopeRef,
      meterType: quota.meterType,
      window: quota.window,
      limit: Number(quota.limit),
      meteredEventCount: coverage.meteredEventCount,
      unpricedEventCount: coverage.unpricedEventCount,
      // Which price rows are missing — the operator's next question, and what a
      // count alone leaves them hunting for.
      unpricedRows: coverage.unpricedRows,
    },
  });
};

/**
 * Fires the `quota.exceeded` webhook once per window for a breached quota.
 *
 * A quota's window always has a discrete fixed key (rolling windows are
 * implemented as fixed windows keyed by the truncated timestamp), and usage
 * only grows within a key, so the fire state is a single stored key: once fired
 * for `windowKey` the quota never re-fires until the window rolls to a new key.
 * No hysteresis is needed (unlike sliding-window usage thresholds).
 *
 * Best-effort and safe to await on the request hot path: the state update is a
 * single row write that only runs on the first breach per window.
 */
export const fireQuotaExceeded = async (args: {
  quota: QuotaInstance;
  windowKey: string;
  observedValue: number;
  now: Date;
}): Promise<void> => {
  const { quota } = args;
  if (quota.firedWindowKey === args.windowKey) return;

  await quota.update({ firedWindowKey: args.windowKey, lastFiredAt: args.now });

  const projectPublicId = await resolveProjectPublicId({
    projectId: quota.projectId,
  });

  log(
    'fireQuotaExceeded: quota=%s scope=%s metric=%s window=%s mode=%s value=%d',
    quota.publicId,
    quota.scope,
    quota.metric,
    quota.window,
    quota.mode,
    args.observedValue
  );

  emitEvent({
    type: QUOTA_EXCEEDED_EVENT,
    projectId: quota.projectId,
    projectPublicId,
    resourceType: 'quota',
    resourceId: quota.publicId,
    // snake_case data keys to match the documented webhook contract.
    data: {
      quota_id: quota.publicId,
      project_id: projectPublicId,
      scope: quota.scope,
      scope_ref: quota.scopeRef,
      metric: quota.metric,
      // Restated with the rest of the identity: with two caps over one
      // scope/metric/window, this is what says which budget breached.
      meter_type: quota.meterType,
      window: quota.window,
      window_key: args.windowKey,
      limit: Number(quota.limit),
      observed_value: args.observedValue,
      mode: quota.mode,
    },
    timestamp: args.now.toISOString(),
  });

  // A `monitor` breach never blocks, so without this entry it leaves no durable
  // trace beyond the webhook. `enforce` breaches need none: they surface as a
  // `429` the audit middleware already records.
  if (quota.mode === 'monitor') {
    enqueueAuditWrite({
      projectPublicId,
      // No principal authorized this: the principal columns stay null and the
      // entry is identified by its `action` — never a fabricated actor.
      action: 'quotas:MonitorBreach',
      // SRN built inline (the audit middleware does the same) to avoid pulling
      // the heavy iam module into this hot-path event helper.
      resourceSrn: `srn:${projectPublicId}:quota:${quota.publicId}`,
      resourcePublicId: quota.publicId,
      // Monitor mode lets the request through, so no request was blocked.
      status: 200,
      detail: {
        kind: 'quota_monitor_breach',
        metric: quota.metric,
        scope: quota.scope,
        scopeRef: quota.scopeRef,
        meterType: quota.meterType,
        window: quota.window,
        windowKey: args.windowKey,
        limit: Number(quota.limit),
        observedValue: args.observedValue,
      },
    });
  }
};
