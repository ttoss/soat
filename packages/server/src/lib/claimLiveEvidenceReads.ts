import createDebug from 'debug';

import { db } from '../db';
import { type LiveCounts, liveCountsOf } from './claimLiveEvidence';
import { EVAL_USAGE_SOURCE } from './evaluationRunExecution';
import { type RollingWindow, rollingWindowStart } from './rollingWindows';

const log = createDebug('soat:agents');

/** A generation that reached one of these served traffic; the rest is in flight. */
const SERVED_STATUSES = ['completed', 'failed'];

/** An approval in one of these was decided by a person. */
const DECIDED_STATUSES = ['approved', 'rejected'];

/**
 * One agent version's production over a rolling `window`: the generations
 * of that version that finished, started by anything but an eval run, and
 * the guardrail tripwires and approvals linked to them by generation id. A
 * row with no generation link says nothing about a version and is not read.
 */
export const readLiveCounts = async (args: {
  agentDbId: number;
  version: number;
  window: RollingWindow;
  now: Date;
}): Promise<LiveCounts> => {
  log(
    'readLiveCounts: agentDbId=%d version=%d window=%s',
    args.agentDbId,
    args.version,
    args.window
  );

  const [rows] = await db.sequelize.query(
    `WITH served AS (
       SELECT g."public_id", g."status"
         FROM "generations" g
        WHERE g."agent_id" = :agentId
          AND g."agent_version" = :version
          AND g."status" IN (:servedStatuses)
          AND g."started_at" >= :since
          AND (g."source" IS NULL OR g."source" <> :evalSource)
     )
     SELECT
       (SELECT count(*) FROM served) AS served,
       (SELECT count(*) FROM served WHERE "status" = 'failed') AS failed,
       (SELECT count(*)
          FROM "guardrail_evaluations" e
          JOIN served s ON e."generation_id" = s."public_id"
         WHERE e."decision" = 'tripwire') AS tripwires,
       (SELECT count(*)
          FROM "approval_items" a
          JOIN served s ON a."generation_id" = s."public_id"
         WHERE a."status" IN (:decidedStatuses)) AS decided,
       (SELECT count(*)
          FROM "approval_items" a
          JOIN served s ON a."generation_id" = s."public_id"
         WHERE a."status" = 'rejected') AS rejected`,
    {
      replacements: {
        agentId: args.agentDbId,
        version: args.version,
        servedStatuses: SERVED_STATUSES,
        decidedStatuses: DECIDED_STATUSES,
        since: rollingWindowStart({ window: args.window, now: args.now }),
        evalSource: EVAL_USAGE_SOURCE,
      },
    }
  );

  return liveCountsOf(rows);
};
