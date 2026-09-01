import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { fireQuotaExceeded, reportUnpricedCostQuota } from './quotaEvents';
import type { QuotaWindow } from './quotas';
import {
  retryAfterSeconds,
  windowKeyFor,
  windowResetsAt,
  windowStartsAt,
} from './quotas';

const log = createDebug('soat:quotas');

type QuotaInstance = InstanceType<(typeof db)['Quota']>;

/**
 * Why the quota refused the work.
 *
 * `limit_exceeded` is the ordinary case: the window aggregate reached the cap.
 * `unpriced_usage` is a `cost_usd` cap the platform cannot evaluate at all —
 * the window metered usage and priced none of it, so the aggregate is 0 no
 * matter what was actually spent. The two are not interchangeable: the first
 * clears when the window rolls, the second only when pricing is configured.
 */
export type QuotaBreachReason = 'limit_exceeded' | 'unpriced_usage';

export type QuotaBreach = {
  quotaId: string;
  scope: string;
  scopeRef: string | null;
  metric: string;
  window: string;
  limit: number;
  resetsAt: Date;
  retryAfter: number;
  reason: QuotaBreachReason;
};

// Which scope to report when several quotas breach at once — the most specific
// wins. `actor` outranks `agent` because it names one end user, the most
// actionable thing to tell a caller who was just blocked.
const scopeRank = (scope: string): number => {
  if (scope === 'actor') return 4;
  if (scope === 'agent') return 3;
  if (scope === 'api_key') return 2;
  return 1;
};

/**
 * The DomainError for a breach — the shared source of the response body across
 * every enforcement point (the request middleware and the token/cost generation
 * gate). Error meta keys are snake_case to match the external REST contract.
 *
 * An `unpriced_usage` refusal is deliberately **not** a 429: waiting for the
 * window to reset changes nothing, so the `Retry-After` contract a 429 carries
 * would be a lie. It reports the unenforceable configuration instead, and omits
 * `resets_at` for the same reason.
 */
export const quotaBreachError = (breach: QuotaBreach): DomainError => {
  if (breach.reason === 'unpriced_usage') {
    return new DomainError(
      'QUOTA_UNENFORCEABLE',
      `Cost quota ${breach.quotaId} cannot be enforced: the current window metered usage but priced none of it.`,
      {
        quota_id: breach.quotaId,
        metric: breach.metric,
        limit: breach.limit,
        window: breach.window,
      }
    );
  }

  return new DomainError(
    'QUOTA_EXCEEDED',
    `Quota exceeded for ${breach.scope}${
      breach.scopeRef ? ` ${breach.scopeRef}` : ''
    }.`,
    {
      quota_id: breach.quotaId,
      metric: breach.metric,
      limit: breach.limit,
      window: breach.window,
      resets_at: breach.resetsAt.toISOString(),
    }
  );
};

/**
 * Atomically increments (upserting on first hit) the counter for one
 * `(quota, window)` and returns the new count. A single statement is both the
 * increment and the check — no read-then-write race. Correct across replicas
 * because the composite primary key serializes conflicting upserts in Postgres.
 */
const incrementCounter = async (args: {
  quotaId: number;
  windowKey: string;
  now: Date;
}): Promise<number> => {
  // Postgres `sequelize.query` returns `[rows, metadata]`; the RETURNING clause
  // puts the new count in `rows`.
  const [rows] = await db.sequelize.query(
    `INSERT INTO "quota_window_counters" ("quota_id", "window_key", "count", "updated_at")
     VALUES (:quotaId, :windowKey, 1, :now)
     ON CONFLICT ("quota_id", "window_key")
     DO UPDATE SET "count" = "quota_window_counters"."count" + 1, "updated_at" = :now
     RETURNING "count"`,
    {
      replacements: {
        quotaId: args.quotaId,
        windowKey: args.windowKey,
        now: args.now,
      },
    }
  );

  // The upsert always returns exactly one row (the inserted or updated
  // counter), so `rows[0]` is guaranteed present.
  const returned = rows as Array<{ count: string | number }>;
  const count = Number(returned[0].count);

  // On the first hit of a new window, opportunistically garbage-collect this
  // quota's expired windows — fixed windows never count a stale key again.
  if (count === 1) {
    await db.sequelize.query(
      `DELETE FROM "quota_window_counters"
       WHERE "quota_id" = :quotaId AND "window_key" <> :windowKey`,
      {
        replacements: { quotaId: args.quotaId, windowKey: args.windowKey },
      }
    );
  }

  return count;
};

// Builds the QuotaBreach attribution record for a breached quota.
const buildBreach = (args: {
  quota: QuotaInstance;
  window: QuotaWindow;
  now: Date;
  reason: QuotaBreachReason;
}): QuotaBreach => {
  const resetsAt = windowResetsAt({ window: args.window, now: args.now });
  return {
    quotaId: args.quota.publicId,
    scope: args.quota.scope,
    scopeRef: args.quota.scopeRef,
    metric: args.quota.metric,
    window: args.quota.window,
    limit: Number(args.quota.limit),
    resetsAt,
    retryAfter: retryAfterSeconds({ resetsAt, now: args.now }),
    reason: args.reason,
  };
};

// Increments one request quota's window counter, fires `quota.exceeded` on the
// first breach per window (both modes), and returns the breach only when it is
// an `enforce` quota (so a `monitor` breach fires the webhook but never blocks).
const evaluateRequestQuota = async (args: {
  quota: QuotaInstance;
  now: Date;
}): Promise<QuotaBreach | null> => {
  const { quota, now } = args;
  const window = quota.window as QuotaWindow;
  const windowKey = windowKeyFor({ window, now });
  const count = await incrementCounter({
    quotaId: (quota as unknown as { id: number }).id,
    windowKey,
    now,
  });

  if (count <= Number(quota.limit)) return null;

  await fireQuotaExceeded({ quota, windowKey, observedValue: count, now });
  return quota.mode === 'enforce'
    ? buildBreach({ quota, window, now, reason: 'limit_exceeded' })
    : null;
};

/**
 * Every request reaching the middleware increments the counter of every
 * matching quota, including requests that will be rejected. Both modes are
 * evaluated: a breach fires the `quota.exceeded` webhook once per window
 * either way, but only `enforce` breaches are returned (and block with 429).
 * Returns the most specific `enforce` breach, or `null`.
 *
 * Matching (`requests` metric): a `project`-scope quota applies to every key in
 * the project; an `api_key`-scope quota to all keys (null ref) or the one named.
 *
 * `apiKeyPublicId: null` admits work that arrived on no API key — an event
 * trigger the bus starts in-process. Only `project`-scope quotas match then: an
 * `api_key`-scope quota is a cap on *a credential*, and counting a keyless
 * admission against it would charge every key for traffic none of them sent.
 */
export const evaluateRequestQuotas = async (args: {
  projectId: number;
  apiKeyPublicId: string | null;
}): Promise<QuotaBreach | null> => {
  const now = new Date();

  const quotas = (await db.Quota.findAll({
    where: { projectId: args.projectId, metric: 'requests' },
  })) as QuotaInstance[];

  const matching = quotas.filter((quota) => {
    if (quota.scope === 'project') return quota.scopeRef == null;
    if (quota.scope === 'api_key') {
      if (args.apiKeyPublicId === null) return false;
      return quota.scopeRef == null || quota.scopeRef === args.apiKeyPublicId;
    }
    return false; // agent scope never matches the requests metric
  });

  const breaches: QuotaBreach[] = [];
  for (const quota of matching) {
    const breach = await evaluateRequestQuota({ quota, now });
    if (breach) breaches.push(breach);
  }

  if (breaches.length === 0) return null;

  breaches.sort((a, b) => {
    return scopeRank(b.scope) - scopeRank(a.scope);
  });
  return breaches[0];
};

// ── Token / cost pre-generation check (Phase 2) ──────────────────────────────

// Tokens are measured in this unit; a `tokens` quota sums the billable
// token-unit component quantities (uncached input + output + cached), excluding
// the non-billable `reasoning_tokens` detail so it is never double counted.
const TOKEN_UNIT = 'token';

/**
 * The outcome of aggregating one window. `total` is the value compared to the
 * limit; `unpricedEventCount` is meaningful only for `cost_usd` and is non-zero
 * only when the window held events and **none** of them were priced — the
 * condition under which a cost cap silently cannot be enforced.
 */
type WindowAggregate = {
  total: number;
  unpricedEventCount: number;
};

/**
 * Sums a `tokens` / `cost_usd` metric over the current fixed window from
 * `UsageEvent` (and its component rows for tokens). Optionally scoped to one
 * agent. Aggregating the meter at check time — rather than keeping a separate
 * counter — is what keeps quotas and metering from ever disagreeing.
 */
const aggregateGenerationMetric = async (args: {
  metric: 'tokens' | 'cost_usd';
  projectId: number;
  agentId: number | null;
  actorId: number | null;
  windowStart: Date;
}): Promise<WindowAggregate> => {
  const where: Record<string | symbol, unknown> = {
    projectId: args.projectId,
    createdAt: { [Op.gte]: args.windowStart },
  };
  if (args.agentId != null) where.agentId = args.agentId;
  if (args.actorId != null) where.actorId = args.actorId;

  if (args.metric === 'cost_usd') {
    const events = await db.UsageEvent.findAll({
      where,
      attributes: ['costUsd'],
    });
    const priced = events.filter((event) => {
      return event.costUsd != null;
    });
    return {
      total: priced.reduce((sum, event) => {
        return sum + Number(event.costUsd);
      }, 0),
      // Only a window that metered something yet priced none of it indicates a
      // pricing gap. An empty window aggregates to a legitimate 0 — reporting
      // it would cry wolf on every idle project.
      unpricedEventCount:
        events.length > 0 && priced.length === 0 ? events.length : 0,
    };
  }

  const events = await db.UsageEvent.findAll({
    where,
    attributes: ['id'],
    include: [
      {
        model: db.UsageComponent,
        as: 'components',
        attributes: ['quantity', 'unit', 'billable'],
      },
    ],
  });
  return {
    total: events.reduce((sum, event) => {
      const components = event.components ?? [];
      return (
        sum +
        components.reduce((componentSum, component) => {
          const counts = component.unit === TOKEN_UNIT && component.billable;
          return componentSum + (counts ? Number(component.quantity) : 0);
        }, 0)
      );
    }, 0),
    // Token quantities are always recorded, so a tokens quota never has a
    // pricing dependency to report.
    unpricedEventCount: 0,
  };
};

/**
 * Resolves the end user an `actor`-scope quota is enforced against: the actor
 * on the generation's session, scoped to the agent's project so a session id
 * from another tenant can never pull an actor into this project's enforcement.
 *
 * Both ids are needed — the public one matches `scope_ref`, the internal one
 * filters the meter. Returns `null` when there is no session, the session does
 * not resolve, or it carries no actor; every one of those means "no end user
 * behind this generation", and actor quotas then match nothing.
 */
const resolveSessionActor = async (args: {
  projectId: number;
  sessionId?: string | null;
}): Promise<{ id: number; publicId: string } | null> => {
  if (!args.sessionId) return null;

  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, projectId: args.projectId },
    attributes: ['actorId'],
  });
  if (!session?.actorId) return null;

  const actor = await db.Actor.findOne({
    where: { id: session.actorId },
    attributes: ['id', 'publicId'],
  });
  if (!actor) return null;

  return { id: actor.id as number, publicId: actor.publicId };
};

// Fires `quota.exceeded` once per window in both modes, but returns the breach
// only for `enforce` — a `monitor` breach webhooks without blocking.
const evaluateGenerationQuota = async (args: {
  quota: QuotaInstance;
  agentInternalId: number;
  actorInternalId: number | null;
  projectId: number;
  now: Date;
}): Promise<QuotaBreach | null> => {
  const { quota, now } = args;
  const window = quota.window as QuotaWindow;
  const scopeToAgent = quota.scope === 'agent' && quota.scopeRef != null;
  // Actor scope always narrows to the generation's own actor, ref'd or not:
  // a null-ref actor quota is one budget *per* actor, not one shared budget
  // (see `evaluateGenerationQuotas`). Matching guarantees an actor is present.
  const scopeToActor = quota.scope === 'actor';
  const { total, unpricedEventCount } = await aggregateGenerationMetric({
    metric: quota.metric as 'tokens' | 'cost_usd',
    projectId: args.projectId,
    agentId: scopeToAgent ? args.agentInternalId : null,
    actorId: scopeToActor ? args.actorInternalId : null,
    windowStart: windowStartsAt({ window, now }),
  });

  // A cost cap over an entirely unpriced window aggregates to 0, so the limit
  // comparison below can never fire however much was actually spent. File the
  // triage item, then refuse: an `enforce` cap that cannot measure the spend it
  // caps must not wave it through, which is the fail-open the cap exists to
  // prevent. `monitor` observes and never blocks, here as everywhere.
  if (unpricedEventCount > 0) {
    await reportUnpricedCostQuota({ quota, unpricedEventCount });
    return quota.mode === 'enforce'
      ? buildBreach({ quota, window, now, reason: 'unpriced_usage' })
      : null;
  }

  if (total < Number(quota.limit)) return null;

  await fireQuotaExceeded({
    quota,
    windowKey: windowKeyFor({ window, now }),
    observedValue: total,
    now,
  });
  return quota.mode === 'enforce'
    ? buildBreach({ quota, window, now, reason: 'limit_exceeded' })
    : null;
};

/**
 * The pre-generation token/cost check: the current window aggregate for every
 * matching `tokens`/`cost_usd` quota against its limit. A breach fires the
 * `quota.exceeded` webhook once per window regardless of mode, but only
 * `enforce` breaches block the new generation with `QUOTA_EXCEEDED`. In-flight
 * generations are never inspected — their tokens are already spent — so a
 * budget may overshoot by at most one generation.
 *
 * Matching: a `project`-scope quota aggregates the whole project; an `agent`
 * scope aggregates that agent, or the whole project with a null ref.
 * `api_key`-scope token/cost quotas are rejected at create time and skipped
 * defensively here, since usage events carry no api-key attribution.
 *
 * **Actor scope.** The end user is derived from `sessionId`, never accepted
 * directly, so a caller cannot spend one actor's budget under another's
 * session. A generation with no session matches no actor quota; cap that
 * traffic with a `project` quota.
 *
 * A null `scope_ref` here means **one budget per actor**, not "the whole
 * project" as it does for `agent` scope: a project-wide aggregate is already
 * what a `project` quota expresses, so pooling all actors would make the
 * combination a duplicate with a misleading name.
 */
export const evaluateGenerationQuotas = async (args: {
  agentId: string;
  projectIds?: number[];
  sessionId?: string;
}): Promise<QuotaBreach | null> => {
  const now = new Date();

  const agentWhere: Record<string, unknown> = { publicId: args.agentId };
  if (args.projectIds !== undefined) agentWhere.projectId = args.projectIds;
  const agent = await db.Agent.findOne({
    where: agentWhere,
    attributes: ['id', 'projectId', 'publicId'],
  });
  if (!agent) return null;

  const agentPublicId = agent.publicId;
  const actor = await resolveSessionActor({
    projectId: agent.projectId,
    sessionId: args.sessionId,
  });

  const quotas = (await db.Quota.findAll({
    where: { projectId: agent.projectId, metric: ['tokens', 'cost_usd'] },
  })) as QuotaInstance[];

  const matching = quotas.filter((quota) => {
    if (quota.scope === 'project') return quota.scopeRef == null;
    if (quota.scope === 'agent') {
      return quota.scopeRef == null || quota.scopeRef === agentPublicId;
    }
    if (quota.scope === 'actor') {
      if (!actor) return false;
      return quota.scopeRef == null || quota.scopeRef === actor.publicId;
    }
    return false; // api_key token/cost is never aggregatable
  });

  const breaches: QuotaBreach[] = [];
  for (const quota of matching) {
    const breach = await evaluateGenerationQuota({
      quota,
      agentInternalId: agent.id,
      actorInternalId: actor?.id ?? null,
      projectId: agent.projectId,
      now,
    });
    if (breach) breaches.push(breach);
  }

  if (breaches.length === 0) return null;

  breaches.sort((a, b) => {
    return scopeRank(b.scope) - scopeRank(a.scope);
  });
  return breaches[0];
};

/**
 * Fail-open wrapper around `evaluateGenerationQuotas` for the generation path.
 * An infrastructure error during the check is logged and swallowed so the
 * generation proceeds — a quota is cost control, not authorization, so one
 * window of unmetered spend beats blocking every generation on a DB blip.
 */
export const checkGenerationQuota = async (args: {
  agentId: string;
  projectIds?: number[];
  sessionId?: string;
}): Promise<QuotaBreach | null> => {
  try {
    return await evaluateGenerationQuotas(args);
  } catch (error) {
    log('checkGenerationQuota: failing open %O', error);
    return null;
  }
};
