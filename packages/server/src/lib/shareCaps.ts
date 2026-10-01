import { Op } from '@ttoss/postgresdb';
import type { Tool } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { emitActivityEntry } from './activity';
import {
  retryAfterSeconds,
  windowKeyFor,
  windowResetsAt,
} from './quotaWindows';
import { parseShareCap } from './shareCapShape';
import { shareResourceSrn } from './shares';

const log = createDebug('soat:shares');

type CappedAcceptance = InstanceType<(typeof db)['ShareAcceptance']> & {
  share: InstanceType<(typeof db)['Share']> & {
    project?: InstanceType<(typeof db)['Project']>;
  };
};

/**
 * The acceptance a call through a share counts against, or `null` when the
 * call is uncapped: the resource is the project's own, or some accepted share
 * of it carries no cap.
 */
const findCappedAcceptance = async (args: {
  resourceType: 'tool' | 'agent';
  resourceId: string;
  projectId: number;
}): Promise<CappedAcceptance | null> => {
  const acceptances = (await db.ShareAcceptance.findAll({
    where: { projectId: args.projectId, status: 'active' },
    include: [
      {
        model: db.Share,
        as: 'share',
        required: true,
        where: {
          resourceType: args.resourceType,
          resourceId: args.resourceId,
          suspendedAt: null,
          revokedAt: null,
          projectId: { [Op.ne]: args.projectId },
        },
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
    order: [['id', 'ASC']],
  })) as CappedAcceptance[];
  const uncapped = acceptances.some((acceptance) => {
    return !acceptance.share.cap;
  });
  return uncapped ? null : (acceptances[0] ?? null);
};

/**
 * Counts one call in the window unless the window is full; a refused call is
 * not counted, so a raised cap admits the next one.
 */
const countCall = async (args: {
  acceptanceId: number;
  windowKey: string;
  calls: number;
  now: Date;
}): Promise<boolean> => {
  const [rows] = await db.sequelize.query(
    `INSERT INTO "share_cap_counters" ("acceptance_id", "window_key", "count", "updated_at")
     VALUES (:acceptanceId, :windowKey, 1, :now)
     ON CONFLICT ("acceptance_id", "window_key")
     DO UPDATE SET "count" = "share_cap_counters"."count" + 1, "updated_at" = :now
     WHERE "share_cap_counters"."count" < :calls
     RETURNING "count"`,
    { replacements: args }
  );
  const counted = rows as Array<{ count: string | number }>;
  if (counted.length === 0) return false;
  if (Number(counted[0].count) === 1) {
    // Fixed windows never count a stale key again.
    await db.ShareCapCounter.destroy({
      where: {
        acceptanceId: args.acceptanceId,
        windowKey: { [Op.ne]: args.windowKey },
      },
    });
  }
  return true;
};

/**
 * Admits one call `projectId` makes to another project's tool or agent
 * through a share, or throws `SHARE_CAP_EXCEEDED` with `retry_after` and
 * records `share_cap_exceeded` in that project. Called before the call leaves,
 * so a refused one reaches nothing and is not metered.
 */
export const admitSharedCall = async (args: {
  resourceType: 'tool' | 'agent';
  resourceId: string;
  projectId: number;
}): Promise<void> => {
  const acceptance = await findCappedAcceptance(args);
  const cap = acceptance ? parseShareCap(acceptance.share.cap) : null;
  if (!acceptance || !cap) return;
  const now = new Date();
  const admitted = await countCall({
    acceptanceId: acceptance.id as number,
    windowKey: windowKeyFor({ window: cap.window, now }),
    calls: cap.calls,
    now,
  });
  if (admitted) return;

  const { share } = acceptance;
  const resetsAt = windowResetsAt({ window: cap.window, now });
  const retryAfter = retryAfterSeconds({ resetsAt, now });
  log(
    'admitSharedCall: refused share=%s projectId=%d retryAfter=%d',
    share.publicId,
    args.projectId,
    retryAfter
  );
  const resource = shareResourceSrn(share);
  await emitActivityEntry({
    projectId: args.projectId,
    kind: 'share_cap_exceeded',
    summary: `Share ${share.publicId} of ${resource} refused a call: ${String(cap.calls)} per ${cap.window} reached`,
    detail: {
      shareId: share.publicId,
      resource,
      publisherProjectId: share.project?.publicId ?? null,
      calls: cap.calls,
      window: cap.window,
    },
    refId: share.publicId,
  });
  throw new DomainError(
    'SHARE_CAP_EXCEEDED',
    `Share '${share.publicId}' allows ${String(cap.calls)} call(s) per ${cap.window}; retry after ${String(retryAfter)}s.`,
    {
      share_id: share.publicId,
      calls: cap.calls,
      window: cap.window,
      resets_at: resetsAt.toISOString(),
      retry_after: retryAfter,
    }
  );
};

/**
 * An agent's tools bound through a share, each call admitted by
 * {@link admitSharedCall} before it runs; a refusal is the call's tool error.
 */
export const admitEachSharedCall = (args: {
  tools: Record<string, Tool>;
  resourceType: 'tool';
  resourceId: string;
  projectId: number;
}): Record<string, Tool> => {
  const admitted: Record<string, Tool> = {};
  for (const [name, bound] of Object.entries(args.tools)) {
    const { execute } = bound;
    admitted[name] = execute
      ? {
          ...bound,
          execute: async (...executeArgs) => {
            await admitSharedCall(args);
            return execute(...executeArgs);
          },
        }
      : bound;
  }
  return admitted;
};
