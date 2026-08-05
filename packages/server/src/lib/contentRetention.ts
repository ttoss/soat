import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { purgeTraceContent, type RedactionPrincipal } from './contentPurge';

const log = createDebug('soat:content-retention');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Root traces claimed per project per query. The sweep loops until a project
 * is drained, so this bounds memory per round-trip, not total work. */
const DEFAULT_BATCH_LIMIT = 100;

/** Safety ceiling per project per tick, so a pathological backlog cannot hold
 * the sweep open indefinitely. Hitting it is logged, never silent. */
const MAX_PER_PROJECT_PER_TICK = 10_000;

/**
 * The principal recorded on a sweep-driven purge. The redaction columns are the
 * proof that erasure happened, so an automated purge names itself rather than
 * borrowing the identity of whoever last touched the project.
 */
const RETENTION_PRINCIPAL: RedactionPrincipal = {
  principalType: 'system',
  principalId: 'retention_sweep',
};

/**
 * Root traces whose content is past the project's window.
 *
 * Only roots are selected: `purgeTraceContent` cascades down the subtree, so
 * every descendant goes with its root. Because a root is always created before
 * its children, a due child always has a due root — selecting roots therefore
 * misses nothing, and it avoids purging the same subtree once per node.
 *
 * `contentRedactedAt: null` keeps the steady-state sweep proportional to what
 * is newly due rather than to all history.
 */
const findDueRootTraces = async (args: {
  projectDbId: number;
  cutoff: Date;
  limit: number;
}) => {
  return db.Trace.findAll({
    where: {
      projectId: args.projectDbId,
      parentTraceId: null,
      contentRedactedAt: null,
      createdAt: { [Op.lt]: args.cutoff },
    },
    attributes: ['id', 'publicId'],
    order: [['id', 'ASC']],
    limit: args.limit,
  });
};

const sweepProject = async (args: {
  projectDbId: number;
  retentionDays: number;
  now: Date;
  batchLimit: number;
}): Promise<number> => {
  const cutoff = new Date(args.now.getTime() - args.retentionDays * DAY_MS);
  let purged = 0;

  for (;;) {
    const due = await findDueRootTraces({
      projectDbId: args.projectDbId,
      cutoff,
      limit: args.batchLimit,
    });
    if (due.length === 0) break;

    for (const trace of due) {
      // Scoped to this project so a purge can never reach across projects, and
      // shared with the REST route so both paths produce identical audit
      // entries, events and `content_redacted_at` semantics — there is exactly
      // one purge implementation (#837).
      await purgeTraceContent({
        traceId: trace.publicId,
        projectIds: [args.projectDbId],
        principal: RETENTION_PRINCIPAL,
      });
      purged += 1;
    }

    if (purged >= MAX_PER_PROJECT_PER_TICK) {
      log(
        'sweepProject: hit the per-tick ceiling projectId=%d purged=%d — the remainder is deferred to the next tick',
        args.projectDbId,
        purged
      );
      break;
    }

    if (due.length < args.batchLimit) break;
  }

  if (purged > 0) {
    log(
      'sweepProject: projectId=%d retentionDays=%d cutoff=%s purged=%d',
      args.projectDbId,
      args.retentionDays,
      cutoff.toISOString(),
      purged
    );
  }

  return purged;
};

/**
 * Content-purges every trace older than its project's
 * `trace_content_retention_days`, turning "the customer must remember to
 * request a purge" into "the system guarantees it" (#837).
 *
 * Retention is opt-in: a project with a `null` window is skipped entirely, so
 * shipping this feature destroys nothing anyone already stored.
 *
 * Safe under overlapping ticks and multiple instances — `purgeTraceContent` is
 * idempotent and the due-set query excludes already-redacted rows, so a
 * concurrent re-run purges nothing twice.
 *
 * Returns the number of root traces purged (each may have cascaded to
 * descendants and their generations).
 */
export const sweepExpiredTraceContent = async (args?: {
  now?: Date;
  batchLimit?: number;
}): Promise<number> => {
  const now = args?.now ?? new Date();
  const batchLimit = args?.batchLimit ?? DEFAULT_BATCH_LIMIT;

  const projects = await db.Project.findAll({
    where: { traceContentRetentionDays: { [Op.ne]: null } },
    attributes: ['id', 'traceContentRetentionDays'],
  });

  if (projects.length === 0) return 0;

  let total = 0;
  for (const project of projects) {
    total += await sweepProject({
      projectDbId: project.id as number,
      retentionDays: project.traceContentRetentionDays as number,
      now,
      batchLimit,
    });
  }

  if (total > 0) {
    log('sweepExpiredTraceContent: purged=%d', total);
  }

  return total;
};
