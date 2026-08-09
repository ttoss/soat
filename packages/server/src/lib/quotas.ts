import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { paginatedList, type PaginatedResult } from './pagination';
import { validateQuotaImmutableFields } from './quotaImmutability';
import {
  QUOTA_WINDOWS,
  type QuotaWindow,
  windowKeyFor,
  windowResetsAt,
} from './quotaWindows';
import { makeResourceAccessor } from './resourceAccessor';

const log = createDebug('soat:quotas');

// Fixed-window math lives in `quotaWindows.ts`; re-exported here so the quota
// module's public surface (consumed by the middleware, enforcement, and tests)
// is unchanged.
export type { QuotaWindow } from './quotaWindows';
export {
  QUOTA_WINDOWS,
  retryAfterSeconds,
  windowKeyFor,
  windowResetsAt,
  windowStartsAt,
} from './quotaWindows';
// The immutability rule lives in `quotaImmutability.ts`; re-exported so callers
// reach it through the module's single public surface.
export {
  QUOTA_IMMUTABLE_FIELDS,
  validateQuotaImmutableFields,
} from './quotaImmutability';

const QUOTA_SCOPES = ['project', 'api_key', 'agent', 'actor'] as const;
const QUOTA_METRICS = ['requests', 'tokens', 'cost_usd'] as const;
export const QUOTA_MODES = ['enforce', 'monitor'] as const;

export type QuotaScope = (typeof QUOTA_SCOPES)[number];
export type QuotaMetric = (typeof QUOTA_METRICS)[number];
export type QuotaMode = (typeof QUOTA_MODES)[number];

type QuotaInstance = InstanceType<(typeof db)['Quota']>;

// ── Mapping ──────────────────────────────────────────────────────────────

export type CurrentUsage = {
  windowKey: string;
  count: number;
  resetsAt: Date;
} | null;

const mapQuota = (quota: QuotaInstance, currentUsage: CurrentUsage) => {
  return {
    id: quota.publicId,
    project_id: quota.project.publicId,
    scope: quota.scope,
    scope_ref: quota.scopeRef,
    metric: quota.metric,
    window: quota.window,
    limit: Number(quota.limit),
    mode: quota.mode,
    current_usage: currentUsage
      ? {
          window_key: currentUsage.windowKey,
          count: currentUsage.count,
          resets_at: currentUsage.resetsAt,
        }
      : null,
    created_at: quota.createdAt,
    updated_at: quota.updatedAt,
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
 * The scopes each metric can actually be enforced for. A combination outside
 * this table is rejected at create time rather than stored as a silent no-op:
 * enforcement aggregates real attribution, so a cap it cannot aggregate would
 * look healthy through the API while protecting nothing.
 *
 * - `requests` is counted by the request middleware, which sees the API key and
 *   the project — but not the agent or end user behind the call, so `agent` and
 *   `actor` are excluded.
 * - `tokens` / `cost_usd` aggregate the usage meter, which carries project,
 *   agent, and end-user (actor) attribution — but no API-key attribution, so
 *   `api_key` is excluded.
 *
 * Widening a row here is backward-compatible; narrowing one is not.
 */
const SCOPES_BY_METRIC: Record<QuotaMetric, readonly QuotaScope[]> = {
  requests: ['project', 'api_key'],
  tokens: ['project', 'agent', 'actor'],
  cost_usd: ['project', 'agent', 'actor'],
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
  if (!SCOPES_BY_METRIC[args.metric].includes(args.scope)) {
    return `scope "${args.scope}" is not valid for metric "${args.metric}".`;
  }
  return validateQuotaLimit({ metric: args.metric, limit: args.limit });
};

/**
 * What a `scope_ref` must name, per entity scope. Keyed by scope so a new entry
 * in `QUOTA_SCOPES` is a type error here until its lookup is declared — a scope
 * can never silently skip the existence check. `project` is absent because it
 * takes no ref at all.
 */
const SCOPE_REF_TARGETS: Record<
  Exclude<QuotaScope, 'project'>,
  { label: string; find: (where: Record<string, unknown>) => Promise<unknown> }
> = {
  api_key: {
    label: 'an API key',
    find: (where) => {
      return db.ApiKey.findOne({ where, attributes: ['id'] });
    },
  },
  agent: {
    label: 'an agent',
    find: (where) => {
      return db.Agent.findOne({ where, attributes: ['id'] });
    },
  },
  actor: {
    label: 'an actor',
    find: (where) => {
      return db.Actor.findOne({ where, attributes: ['id'] });
    },
  },
};

/**
 * Verifies `scopeRef` names an existing api key / agent / actor in the same
 * project. A null/undefined ref (applies to all entities of the scope) is
 * always valid. `project` scope never carries a ref. Throws VALIDATION_FAILED
 * on a mismatch.
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

  const target = SCOPE_REF_TARGETS[args.scope];
  const found = await target.find({
    publicId: args.scopeRef,
    projectId: args.projectId,
  });
  if (!found) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `scope_ref '${args.scopeRef}' does not reference ${target.label} in this project.`
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

const quotas = makeResourceAccessor<QuotaInstance>({
  model: () => {
    return db.Quota;
  },
  includes: getQuotaIncludes,
  label: 'Quota',
});

const reloadWithIncludes = async (row: {
  id?: unknown;
}): Promise<QuotaInstance> => {
  return quotas.reload(row);
};

const findQuotaInstance = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<QuotaInstance> => {
  return quotas.getByPublicId({ id: args.id, projectIds: args.projectIds });
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

  const created = await reloadWithIncludes(quota);
  return mapQuota(
    created,
    await loadCurrentUsage({ quota: created, now: new Date() })
  );
};

export const listQuotas = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<ReturnType<typeof mapQuota>>> => {
  log('listQuotas: projectIds=%o', args.projectIds);

  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Quota.findAndCountAll({
        where,
        include: getQuotaIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (quota) => {
      return mapQuota(quota as QuotaInstance, null);
    },
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
  // Immutable fields are accepted so callers that carry the full desired state
  // (formation templates) can be validated here rather than silently dropping
  // them. Supplying a value that differs from the stored one is an error; the
  // REST route rejects these fields earlier via its PATCH field allowlist.
  scope?: unknown;
  scopeRef?: unknown;
  metric?: unknown;
  window?: unknown;
}): Promise<ReturnType<typeof mapQuota>> => {
  log('updateQuota: id=%s', args.id);

  const quota = await findQuotaInstance({
    projectIds: args.projectIds,
    id: args.id,
  });

  // Enforced before any field is written, so a rejected update leaves the quota
  // exactly as it was rather than applying `limit`/`mode` piecemeal.
  const immutableError = validateQuotaImmutableFields({
    next: {
      scope: args.scope,
      scopeRef: args.scopeRef,
      metric: args.metric,
      window: args.window,
    },
    current: {
      scope: quota.scope,
      scopeRef: quota.scopeRef,
      metric: quota.metric,
      window: quota.window,
    },
  });
  if (immutableError) {
    log('updateQuota: rejected immutable change id=%s', args.id);
    throw new DomainError('VALIDATION_FAILED', immutableError);
  }

  const updates: Record<string, unknown> = {};

  if (args.limit !== undefined) {
    const limitError = validateQuotaLimit({
      metric: quota.metric as QuotaMetric,
      limit: args.limit,
    });
    if (limitError) {
      throw new DomainError('VALIDATION_FAILED', limitError);
    }
    const nextLimit = String(Number(args.limit));
    // The once-per-window fire guard is keyed to the window alone, so a breach
    // already fired in this window would silence every later breach for the
    // rest of it — including breaches of the *new* limit. Since raising a
    // breached cap is the core monitor-mode tuning loop (and `calendar_month`
    // windows stay open for weeks), re-arm the guard whenever the limit
    // actually changes: a different limit makes any subsequent breach a
    // distinct event worth reporting. `lastFiredAt` is left alone — it records
    // when the quota genuinely last fired.
    if (nextLimit !== String(Number(quota.limit))) {
      updates.firedWindowKey = null;
    }
    updates.limit = nextLimit;
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
