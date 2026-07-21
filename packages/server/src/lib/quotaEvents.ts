import createDebug from 'debug';

import type { db } from '../db';
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
};
