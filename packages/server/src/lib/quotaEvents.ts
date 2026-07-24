import createDebug from 'debug';

import type { db } from '../db';
import { enqueueAuditWrite } from './auditQueue';
import { emitEvent, resolveProjectPublicId } from './eventBus';

const log = createDebug('soat:quotas');

// The webhook event fired the first time a quota is breached within a window,
// for both `enforce` and `monitor` quotas. `monitor` quotas fire this and
// nothing else (they never block); `enforce` quotas fire it in addition to the
// 429.
export const QUOTA_EXCEEDED_EVENT = 'quota.exceeded';

type QuotaInstance = InstanceType<(typeof db)['Quota']>;

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
      window: quota.window,
      window_key: args.windowKey,
      limit: Number(quota.limit),
      observed_value: args.observedValue,
      mode: quota.mode,
    },
    timestamp: args.now.toISOString(),
  });

  // A `monitor` breach never blocks, so the request it rode in on returns
  // success and leaves no durable trace of the breach beyond this webhook. Write
  // a system-attributed audit entry so the breach is queryable after the fact —
  // the same once-per-window guard above keeps it to one entry per window.
  // `enforce` breaches need no entry here: they surface as a `429` the audit
  // middleware already records on the blocked request.
  if (quota.mode === 'monitor') {
    enqueueAuditWrite({
      projectPublicId,
      // No principal authorized this: the principal columns stay null and the
      // entry is identified by its `action` — never a fabricated actor.
      action: 'quotas:MonitorBreach',
      // SRN built inline (the audit middleware does the same) to avoid pulling
      // the heavy iam module into this hot-path event helper.
      resourceSrn: `soat:${projectPublicId}:quota:${quota.publicId}`,
      resourcePublicId: quota.publicId,
      // Monitor mode lets the request through, so no request was blocked.
      status: 200,
      detail: {
        kind: 'quota_monitor_breach',
        metric: quota.metric,
        scope: quota.scope,
        scopeRef: quota.scopeRef,
        window: quota.window,
        windowKey: args.windowKey,
        limit: Number(quota.limit),
        observedValue: args.observedValue,
      },
    });
  }
};
