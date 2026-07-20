import createDebug from 'debug';

import { db } from '../db';
import type { QuotaWindow } from './quotas';
import { retryAfterSeconds, windowKeyFor, windowResetsAt } from './quotas';

const log = createDebug('soat:quotas');

type QuotaInstance = InstanceType<(typeof db)['Quota']>;

export type QuotaBreach = {
  quotaId: string;
  scope: string;
  scopeRef: string | null;
  metric: string;
  window: string;
  limit: number;
  resetsAt: Date;
  retryAfter: number;
};

/** Specificity for attribution: agent > api_key > project. */
const scopeRank = (scope: string): number => {
  if (scope === 'agent') return 3;
  if (scope === 'api_key') return 2;
  return 1;
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

  const returned = rows as Array<{ count: string | number }>;
  const count = Number(returned[0]?.count ?? 0);

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

/**
 * Every request that reaches the middleware increments the counter of every
 * matching `enforce` quota — including requests that will be rejected. Returns
 * the most specific breached quota for attribution, or `null` when nothing
 * breached.
 *
 * Matching (`requests` metric): a `project`-scope quota applies to every key in
 * the project; an `api_key`-scope quota applies to all keys (null ref) or the
 * one named key. `monitor` quotas are a pass-through no-op in Phase 1, so only
 * `enforce` quotas are counted here.
 */
export const evaluateRequestQuotas = async (args: {
  projectId: number;
  apiKeyPublicId: string;
  now?: Date;
}): Promise<QuotaBreach | null> => {
  const now = args.now ?? new Date();

  const quotas = (await db.Quota.findAll({
    where: {
      projectId: args.projectId,
      metric: 'requests',
      mode: 'enforce',
    },
  })) as QuotaInstance[];

  const matching = quotas.filter((quota) => {
    if (quota.scope === 'project') return quota.scopeRef == null;
    if (quota.scope === 'api_key') {
      return quota.scopeRef == null || quota.scopeRef === args.apiKeyPublicId;
    }
    return false; // agent scope never matches the requests metric
  });

  if (matching.length === 0) return null;

  const breaches: QuotaBreach[] = [];

  for (const quota of matching) {
    const window = quota.window as QuotaWindow;
    const windowKey = windowKeyFor({ window, now });
    const count = await incrementCounter({
      quotaId: (quota as unknown as { id: number }).id,
      windowKey,
      now,
    });

    const limit = Number(quota.limit);
    if (count > limit) {
      const resetsAt = windowResetsAt({ window, now });
      breaches.push({
        quotaId: quota.publicId,
        scope: quota.scope,
        scopeRef: quota.scopeRef,
        metric: quota.metric,
        window: quota.window,
        limit,
        resetsAt,
        retryAfter: retryAfterSeconds({ resetsAt, now }),
      });
    }
  }

  if (breaches.length === 0) return null;

  breaches.sort((a, b) => {
    return scopeRank(b.scope) - scopeRank(a.scope);
  });

  const breach = breaches[0];
  log(
    'evaluateRequestQuotas: breach quota=%s scope=%s limit=%d',
    breach.quotaId,
    breach.scope,
    breach.limit
  );
  return breach;
};
