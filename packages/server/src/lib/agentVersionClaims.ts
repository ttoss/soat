import createDebug from 'debug';

import { db } from '../db';
import { agents } from './agentAccessor';
import { agentVersionStore } from './agentVersionSnapshot';
import { ageReason, type LiveCounts, liveReasons } from './claimLiveEvidence';
import { readLiveCounts } from './claimLiveEvidenceReads';
import { readEvalRunDefinition } from './evaluationRunDefinition';
import {
  isVerdict,
  type Verdict,
  type VerdictReason,
  worseOf,
  worstVerdict,
} from './evaluationVerdict';
import { type Page, pageOf } from './pagination';
import { toResourceRef } from './resourceVersions';

const log = createDebug('soat:agents');

/**
 * The claims an agent version holds (the agents module doc — Eval-gated
 * promotion), and the one home of a claim's verdict: the promotion gate and
 * the pawl on promotion read it here and never query eval runs themselves.
 */

export type AgentRef = {
  /** Internal row id — the FK evals and archived versions are matched on. */
  dbId: number;
  publicId: string;
  projectId: number;
};

type EvalRunRow = InstanceType<(typeof db)['EvalRun']>;

/** A run is only evidence once it has finished and reported a verdict. */
const COMPLETED_RUN_STATUS = 'completed';

/**
 * The run that speaks for one version of an agent on one eval: the newest
 * `completed` run of it pinned to that version **and recorded against this
 * agent**, whatever its verdict. A newer run that does not support the claim
 * revokes an older one that did, and a run of another agent that happens to
 * share the version number — an eval can be repointed — is not evidence.
 */
export const speakingRun = async (args: {
  evalPublicId: string;
  agent: AgentRef;
  version: number;
}): Promise<EvalRunRow | null> => {
  const evaluation = await db.Eval.findOne({
    where: { publicId: args.evalPublicId, projectId: args.agent.projectId },
    attributes: ['id'],
  });
  // A gate's eval was validated when the gate was set, so this only fires if
  // it was deleted mid-rollout. An unsatisfiable gate is the safe reading:
  // promotion stays blocked until the release is re-set or aborted.
  if (!evaluation) return null;

  return db.EvalRun.findOne({
    where: {
      evalId: evaluation.id as number,
      agentPublicId: args.agent.publicId,
      agentVersion: args.version,
      status: COMPLETED_RUN_STATUS,
    },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
};

/** The speaking run of every eval in the agent's project, keyed by eval id. */
export const speakingRuns = async (args: {
  agent: AgentRef;
  version: number;
}): Promise<Map<string, EvalRunRow>> => {
  const runs = await db.EvalRun.findAll({
    where: {
      agentPublicId: args.agent.publicId,
      agentVersion: args.version,
      status: COMPLETED_RUN_STATUS,
    },
    include: [
      {
        model: db.Eval,
        as: 'eval',
        attributes: ['publicId'],
        where: { projectId: args.agent.projectId },
        required: true,
      },
    ],
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  const byEval = new Map<string, EvalRunRow>();
  for (const run of runs) {
    if (!byEval.has(run.eval.publicId)) byEval.set(run.eval.publicId, run);
  }
  return byEval;
};

/**
 * What a claim's verdict reads beyond its run, shared by every claim of one
 * version in one read: the production counts are read once per window.
 */
export type ClaimReading = {
  agent: AgentRef;
  version: number;
  now: Date;
  counts: (windowDays: number) => Promise<LiveCounts>;
};

export const claimReading = (args: {
  agent: AgentRef;
  version: number;
}): ClaimReading => {
  const now = new Date();
  const byWindow = new Map<number, Promise<LiveCounts>>();
  return {
    agent: args.agent,
    version: args.version,
    now,
    counts: (windowDays) => {
      const read =
        byWindow.get(windowDays) ??
        readLiveCounts({
          agentDbId: args.agent.dbId,
          version: args.version,
          windowDays,
          now,
        });
      byWindow.set(windowDays, read);
      return read;
    },
  };
};

/** The reasons the run's recorded evidence adds beyond its items. */
const claimSideReasons = async (args: {
  run: EvalRunRow;
  reading: ClaimReading;
}): Promise<VerdictReason[]> => {
  const evidence = readEvalRunDefinition({ run: args.run })?.evidence;
  const reasons: VerdictReason[] = [];
  if (evidence?.live) {
    reasons.push(
      ...liveReasons({
        live: evidence.live,
        counts: await args.reading.counts(evidence.live.window_days),
      })
    );
  }
  if (evidence?.max_run_age_days !== undefined) {
    reasons.push(
      ageReason({
        maxDays: evidence.max_run_age_days,
        finishedAt: args.run.finishedAt,
        now: args.reading.now,
      })
    );
  }
  return reasons;
};

/** A claim as the claims read serves it and a promoted version records it. */
export type VersionClaim = {
  eval_id: string;
  eval_run_id: string;
  claim: Record<string, unknown> | null;
  verdict: Verdict | null;
  verdict_reasons: unknown[] | null;
  settled_at: Date | null;
};

/**
 * A claim and its verdict: the run's verdict, made worse by every rule the
 * run's recorded evidence declares beyond its items (production, age). The
 * run's own verdict never moves. No verdict when the run has none.
 */
export const versionClaimOf = async (args: {
  evalId: string;
  run: EvalRunRow;
  reading: ClaimReading;
}): Promise<VersionClaim> => {
  const { run } = args;
  const extra = await claimSideReasons({ run, reading: args.reading });
  const reasons = [...(run.verdictReasons ?? []), ...extra];
  return {
    eval_id: args.evalId,
    eval_run_id: run.publicId,
    claim: run.claim,
    verdict: isVerdict(run.verdict)
      ? worseOf(run.verdict, worstVerdict(extra))
      : null,
    verdict_reasons: reasons.length > 0 ? reasons : run.verdictReasons,
    settled_at: run.finishedAt,
  };
};

/** Every claim the speaking runs carry; a run with none holds none. */
export const versionClaimsOf = async (args: {
  runs: Map<string, EvalRunRow>;
  reading: ClaimReading;
}): Promise<VersionClaim[]> => {
  const claimed = [...args.runs].filter(([, run]) => {
    return run.claim !== null;
  });
  return Promise.all(
    claimed.map(([evalId, run]) => {
      return versionClaimOf({ evalId, run, reading: args.reading });
    })
  );
};

/** The agent a version read names, within the caller's projects, and its version row. */
const findVersion = async (args: {
  projectIds?: number[];
  agentId: string;
  version: number;
}) => {
  const agent = await db.Agent.findOne({
    where: agents.scopedWhere({
      id: args.agentId,
      projectIds: args.projectIds,
    }),
  });
  if (!agent) throw agents.notFound(args.agentId);
  const row = await agentVersionStore.findVersionRow({
    resource: toResourceRef(agent),
    version: args.version,
  });
  const ref: AgentRef = {
    dbId: agent.id as number,
    publicId: agent.publicId,
    projectId: agent.projectId as number,
  };
  return { agent: ref, row };
};

export const listAgentVersionClaims = async (args: {
  projectIds?: number[];
  agentId: string;
  version: number;
  limit?: number;
  cursor?: string;
}): Promise<Page<VersionClaim>> => {
  log(
    'listAgentVersionClaims: agentId=%s version=%d',
    args.agentId,
    args.version
  );

  const { agent } = await findVersion(args);
  const claims = (
    await versionClaimsOf({
      runs: await speakingRuns({ agent, version: args.version }),
      reading: claimReading({ agent, version: args.version }),
    })
  ).sort((a, b) => {
    // By code point, not locale: a page boundary must not move with the
    // server's locale. Eval ids are unique, so no two compare equal.
    return a.eval_id < b.eval_id ? -1 : 1;
  });

  return pageOf({
    items: claims,
    limit: args.limit,
    cursor: args.cursor,
    filters: { agentId: args.agentId, version: args.version },
  });
};

/** The claims a promotion recorded on the version it made live; none otherwise. */
export const listAgentVersionPromotionClaims = async (args: {
  projectIds?: number[];
  agentId: string;
  version: number;
  limit?: number;
  cursor?: string;
}): Promise<Page<unknown>> => {
  log(
    'listAgentVersionPromotionClaims: agentId=%s version=%d',
    args.agentId,
    args.version
  );

  const { row } = await findVersion(args);
  const recorded: unknown = row.get('claims');
  return pageOf({
    items: Array.isArray(recorded) ? recorded : [],
    limit: args.limit,
    cursor: args.cursor,
    filters: { agentId: args.agentId, version: args.version },
  });
};
