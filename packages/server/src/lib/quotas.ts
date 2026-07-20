import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';

const log = createDebug('soat:quotas');

export const QUOTA_SCOPES = ['project', 'api_key', 'agent'] as const;
export const QUOTA_METRICS = ['requests', 'tokens', 'cost_usd'] as const;
export const QUOTA_WINDOWS = [
  'rolling_1m',
  'rolling_1h',
  'rolling_24h',
  'calendar_month',
] as const;
export const QUOTA_MODES = ['enforce', 'monitor'] as const;

export type QuotaScope = (typeof QUOTA_SCOPES)[number];
export type QuotaMetric = (typeof QUOTA_METRICS)[number];
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];
export type QuotaMode = (typeof QUOTA_MODES)[number];

type QuotaInstance = InstanceType<(typeof db)['Quota']>;

// ── Window helpers (shared with the request-quota middleware) ────────────────

/**
 * The fixed-window key a timestamp falls into for a given window. Rolling
 * windows are implemented as fixed windows keyed by the truncated timestamp
 * (`2026-07-07T12:31Z` for `rolling_1m`); `calendar_month` keys are `YYYY-MM`,
 * matching metering's convention.
 */
export const windowKeyFor = (args: {
  window: QuotaWindow;
  now: Date;
}): string => {
  const iso = args.now.toISOString(); // e.g. 2026-07-07T12:31:45.123Z
  switch (args.window) {
    case 'rolling_1m':
      return `${iso.slice(0, 16)}Z`; // 2026-07-07T12:31Z
    case 'rolling_1h':
      return `${iso.slice(0, 13)}Z`; // 2026-07-07T12Z
    case 'rolling_24h':
      return `${iso.slice(0, 10)}Z`; // 2026-07-07Z
    case 'calendar_month':
      return iso.slice(0, 7); // 2026-07
    default:
      return iso;
  }
};

/**
 * The instant the current window rolls over — the start of the next fixed
 * window. Used for the `resets_at` field and the `Retry-After` header.
 */
export const windowResetsAt = (args: {
  window: QuotaWindow;
  now: Date;
}): Date => {
  const d = new Date(args.now.getTime());
  switch (args.window) {
    case 'rolling_1m':
      d.setUTCSeconds(0, 0);
      d.setUTCMinutes(d.getUTCMinutes() + 1);
      return d;
    case 'rolling_1h':
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() + 1);
      return d;
    case 'rolling_24h':
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + 1);
      return d;
    case 'calendar_month':
      return new Date(
        Date.UTC(args.now.getUTCFullYear(), args.now.getUTCMonth() + 1, 1)
      );
    default:
      return d;
  }
};

/** Seconds from `now` until `resetsAt`, floored at 0, rounded up. */
export const retryAfterSeconds = (args: {
  resetsAt: Date;
  now: Date;
}): number => {
  return Math.max(
    0,
    Math.ceil((args.resetsAt.getTime() - args.now.getTime()) / 1000)
  );
};

// ── Mapping ──────────────────────────────────────────────────────────────

export type CurrentUsage = {
  windowKey: string;
  count: number;
  resetsAt: Date;
} | null;

export const mapQuota = (quota: QuotaInstance, currentUsage: CurrentUsage) => {
  return {
    id: quota.publicId,
    projectId: quota.project.publicId,
    scope: quota.scope,
    scopeRef: quota.scopeRef,
    metric: quota.metric,
    window: quota.window,
    limit: Number(quota.limit),
    mode: quota.mode,
    currentUsage: currentUsage
      ? {
          windowKey: currentUsage.windowKey,
          count: currentUsage.count,
          resetsAt: currentUsage.resetsAt,
        }
      : null,
    createdAt: quota.createdAt,
    updatedAt: quota.updatedAt,
  };
};

const getQuotaIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

// ── Validation ─────────────────────────────────────────────────────────────

const isOneOf = <T extends readonly string[]>(
  values: T,
  value: unknown
): value is T[number] => {
  return (
    typeof value === 'string' && (values as readonly string[]).includes(value)
  );
};

/**
 * `limit` must be a number > 0. For `requests` and `tokens` it must be a
 * positive integer; fractional limits are valid only for `cost_usd`.
 */
export const validateQuotaLimit = (args: {
  metric: QuotaMetric;
  limit: unknown;
}): string | null => {
  const value =
    typeof args.limit === 'number'
      ? args.limit
      : typeof args.limit === 'string' && args.limit.trim() !== ''
        ? Number(args.limit)
        : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return 'limit must be a number greater than 0.';
  }
  if (args.metric !== 'cost_usd' && !Number.isInteger(value)) {
    return `limit must be a positive integer for metric "${args.metric}".`;
  }
  return null;
};

/**
 * Validates the immutable shape of a quota at create time. Returns a message on
 * the first problem, or `null` when valid. Pure — shared as the single source of
 * truth for the create/update rules.
 */
export const validateQuotaShape = (args: {
  scope: unknown;
  metric: unknown;
  window: unknown;
  mode: unknown;
  limit: unknown;
}): string | null => {
  if (!isOneOf(QUOTA_SCOPES, args.scope)) {
    return `scope must be one of ${QUOTA_SCOPES.join(' / ')}.`;
  }
  if (!isOneOf(QUOTA_METRICS, args.metric)) {
    return `metric must be one of ${QUOTA_METRICS.join(' / ')}.`;
  }
  if (!isOneOf(QUOTA_WINDOWS, args.window)) {
    return `window must be one of ${QUOTA_WINDOWS.join(' / ')}.`;
  }
  if (!isOneOf(QUOTA_MODES, args.mode)) {
    return `mode must be one of ${QUOTA_MODES.join(' / ')}.`;
  }
  // scope: agent + metric: requests is rejected — an agent's activity is not
  // inbound HTTP traffic and no precise per-request agent attribution exists.
  if (args.scope === 'agent' && args.metric === 'requests') {
    return 'scope "agent" is not valid for metric "requests".';
  }
  return validateQuotaLimit({ metric: args.metric, limit: args.limit });
};

/**
 * Verifies `scopeRef` names an existing api key / agent in the same project. A
 * null/undefined ref (applies to all entities of the scope) is always valid.
 * `project` scope never carries a ref. Throws VALIDATION_FAILED on a mismatch.
 */
const assertScopeRefValid = async (args: {
  projectId: number;
  scope: QuotaScope;
  scopeRef: string | null;
}): Promise<void> => {
  if (args.scopeRef == null) return;

  if (args.scope === 'project') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'scope "project" does not take a scope_ref.'
    );
  }

  if (args.scope === 'api_key') {
    const key = await db.ApiKey.findOne({
      where: { publicId: args.scopeRef, projectId: args.projectId },
      attributes: ['id'],
    });
    if (!key) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `scope_ref '${args.scopeRef}' does not reference an API key in this project.`
      );
    }
    return;
  }

  // agent
  const agent = await db.Agent.findOne({
    where: { publicId: args.scopeRef, projectId: args.projectId },
    attributes: ['id'],
  });
  if (!agent) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `scope_ref '${args.scopeRef}' does not reference an agent in this project.`
    );
  }
};

// ── Current usage ────────────────────────────────────────────────────────

const loadCurrentUsage = async (args: {
  quota: QuotaInstance;
  now: Date;
}): Promise<CurrentUsage> => {
  // Only the `requests` metric has a counter table in Phase 1; token/cost
  // windows aggregate UsageMeter at check time (Phase 2).
  if (args.quota.metric !== 'requests') return null;

  const windowKey = windowKeyFor({
    window: args.quota.window as QuotaWindow,
    now: args.now,
  });
  const counter = await db.QuotaWindowCounter.findOne({
    where: {
      quotaId: (args.quota as unknown as { id: number }).id,
      windowKey,
    },
  });
  return {
    windowKey,
    count: counter ? Number(counter.count) : 0,
    resetsAt: windowResetsAt({
      window: args.quota.window as QuotaWindow,
      now: args.now,
    }),
  };
};

// ── CRUD ───────────────────────────────────────────────────────────────────

const reloadWithIncludes = async (id: number): Promise<QuotaInstance> => {
  const reloaded = await db.Quota.findOne({
    where: { id },
    include: getQuotaIncludes(),
  });
  return reloaded as QuotaInstance;
};

const findQuotaInstance = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<QuotaInstance> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const quota = await db.Quota.findOne({
    where,
    include: getQuotaIncludes(),
  });

  if (!quota) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Quota '${args.id}' not found.`
    );
  }

  return quota as QuotaInstance;
};

export const createQuota = async (args: {
  projectId: number;
  scope: string;
  scopeRef?: string | null;
  metric: string;
  window: string;
  limit: unknown;
  mode?: string;
}): Promise<ReturnType<typeof mapQuota>> => {
  const mode = args.mode ?? 'enforce';
  log(
    'createQuota: projectId=%d scope=%s metric=%s window=%s mode=%s',
    args.projectId,
    args.scope,
    args.metric,
    args.window,
    mode
  );

  const shapeError = validateQuotaShape({
    scope: args.scope,
    metric: args.metric,
    window: args.window,
    mode,
    limit: args.limit,
  });
  if (shapeError) {
    throw new DomainError('VALIDATION_FAILED', shapeError);
  }

  const scopeRef = args.scopeRef ?? null;
  await assertScopeRefValid({
    projectId: args.projectId,
    scope: args.scope as QuotaScope,
    scopeRef,
  });

  // Duplicate = pure redundancy under the all-enforce precedence rule. A quota
  // is uniquely identified by (project, scope, scope_ref, metric, window).
  const existing = await db.Quota.findOne({
    where: {
      projectId: args.projectId,
      scope: args.scope,
      scopeRef,
      metric: args.metric,
      window: args.window,
    },
    attributes: ['id'],
  });
  if (existing) {
    throw new DomainError(
      'QUOTA_CONFLICT',
      'A quota with the same scope, scope_ref, metric, and window already exists in this project.'
    );
  }

  const quota = await db.Quota.create({
    projectId: args.projectId,
    scope: args.scope,
    scopeRef,
    metric: args.metric,
    window: args.window,
    limit: String(Number(args.limit)),
    mode,
  });

  log('createQuota: created id=%s', quota.publicId);

  const created = await reloadWithIncludes(
    (quota as unknown as { id: number }).id
  );
  return mapQuota(
    created,
    await loadCurrentUsage({ quota: created, now: new Date() })
  );
};

export const listQuotas = async (args: {
  projectIds?: number[];
}): Promise<ReturnType<typeof mapQuota>[]> => {
  log('listQuotas: projectIds=%o', args.projectIds);

  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const quotas = await db.Quota.findAll({
    where,
    include: getQuotaIncludes(),
    order: [['createdAt', 'DESC']],
  });

  return quotas.map((quota) => {
    return mapQuota(quota as QuotaInstance, null);
  });
};

export const getQuota = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<ReturnType<typeof mapQuota>> => {
  log('getQuota: id=%s', args.id);
  const quota = await findQuotaInstance(args);
  const currentUsage = await loadCurrentUsage({ quota, now: new Date() });
  return mapQuota(quota, currentUsage);
};

export const updateQuota = async (args: {
  projectIds?: number[];
  id: string;
  limit?: unknown;
  mode?: string;
}): Promise<ReturnType<typeof mapQuota>> => {
  log('updateQuota: id=%s', args.id);

  const quota = await findQuotaInstance({
    projectIds: args.projectIds,
    id: args.id,
  });

  const updates: Record<string, unknown> = {};

  if (args.limit !== undefined) {
    const limitError = validateQuotaLimit({
      metric: quota.metric as QuotaMetric,
      limit: args.limit,
    });
    if (limitError) {
      throw new DomainError('VALIDATION_FAILED', limitError);
    }
    updates.limit = String(Number(args.limit));
  }

  if (args.mode !== undefined) {
    if (!isOneOf(QUOTA_MODES, args.mode)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `mode must be one of ${QUOTA_MODES.join(' / ')}.`
      );
    }
    updates.mode = args.mode;
  }

  await quota.update(updates);

  const currentUsage = await loadCurrentUsage({ quota, now: new Date() });
  return mapQuota(quota, currentUsage);
};

export const deleteQuota = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deleteQuota: id=%s', args.id);

  const quota = await findQuotaInstance({
    projectIds: args.projectIds,
    id: args.id,
  });

  // Counters are owned by the quota; drop them before the parent so no orphan
  // rows are left behind.
  await db.QuotaWindowCounter.destroy({
    where: { quotaId: (quota as unknown as { id: number }).id },
  });

  await quota.destroy();
};
