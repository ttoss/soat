import createDebug from 'debug';

import { db } from '../db';
import { agents } from './agentAccessor';
import { agentVersionStore } from './agentVersionSnapshot';
import {
  ageReason,
  type LiveCounts,
  liveReasons,
  parseLiveEvidence,
  unreadableLiveReason,
} from './claimLiveEvidence';
import { readLiveCounts } from './claimLiveEvidenceReads';
import {
  calibrationReasons,
  externallyGradedKeys,
  parseMinCalibration,
  scorerFingerprint,
  unreadableCalibrationReason,
} from './evaluationCalibration';
import { versionRunCalibrations } from './evaluationLabels';
import {
  type EvalRunDefinition,
  readEvalRunDefinition,
} from './evaluationRunDefinition';
import { readScorerModels } from './evaluationScorerModels';
import {
  isVerdict,
  type Verdict,
  type VerdictReason,
  worseOf,
  worstVerdict,
} from './evaluationVerdict';
import { type Page, pageOf } from './pagination';
import { isPlainObject } from './plainObject';
import { toResourceRef } from './resourceVersions';
import type { RollingWindow } from './rollingWindows';

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
  log(
    'speakingRun: eval=%s agent=%s version=%d',
    args.evalPublicId,
    args.agent.publicId,
    args.version
  );
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

/**
 * The speaking run of every eval in the agent's project, keyed by eval id.
 * Picked in SQL, one per eval: a version served for months holds hundreds of
 * runs per eval, and only the newest of each is read.
 */
export const speakingRuns = async (args: {
  agent: AgentRef;
  version: number;
}): Promise<Map<string, EvalRunRow>> => {
  log('speakingRuns: agent=%s version=%d', args.agent.publicId, args.version);
  const [newest] = await db.sequelize.query(
    `SELECT DISTINCT ON (r."eval_id") r."id"
       FROM "eval_runs" r
       JOIN "evals" e ON e."id" = r."eval_id"
      WHERE r."agent_public_id" = :agentPublicId
        AND r."agent_version" = :version
        AND r."status" = :status
        AND e."project_id" = :projectId
      ORDER BY r."eval_id", r."created_at" DESC, r."id" DESC`,
    {
      replacements: {
        agentPublicId: args.agent.publicId,
        version: args.version,
        status: COMPLETED_RUN_STATUS,
        projectId: args.agent.projectId,
      },
    }
  );
  const ids = newest.flatMap((row) => {
    return isPlainObject(row) && typeof row.id === 'number' ? [row.id] : [];
  });
  if (ids.length === 0) return new Map();

  const runs = await db.EvalRun.findAll({
    where: { id: ids },
    include: [{ model: db.Eval, as: 'eval', attributes: ['publicId'] }],
  });
  return new Map(
    runs.map((run) => {
      return [run.eval.publicId, run];
    })
  );
};

/**
 * What a claim's verdict reads beyond its run, shared by every claim of one
 * version in one read: the production counts are read once per window.
 */
export type ClaimReading = {
  agent: AgentRef;
  version: number;
  now: Date;
  counts: (window: RollingWindow) => Promise<LiveCounts>;
};

export const claimReading = (args: {
  agent: AgentRef;
  version: number;
}): ClaimReading => {
  log('claimReading: agent=%s version=%d', args.agent.publicId, args.version);
  const now = new Date();
  const byWindow = new Map<RollingWindow, Promise<LiveCounts>>();
  return {
    agent: args.agent,
    version: args.version,
    now,
    counts: (window) => {
      const read =
        byWindow.get(window) ??
        readLiveCounts({
          agentDbId: args.agent.dbId,
          version: args.version,
          window,
          now,
        });
      byWindow.set(window, read);
      return read;
    },
  };
};

/** The production rules the run recorded, against the version's traffic. */
const liveSideReasons = async (args: {
  rule: unknown;
  reading: ClaimReading;
}): Promise<VerdictReason[]> => {
  const parsed = parseLiveEvidence(args.rule);
  if ('problem' in parsed) return [unreadableLiveReason()];
  return liveReasons({
    live: parsed.live,
    counts: await args.reading.counts(parsed.live.window),
  });
};

/**
 * One reason per externally graded scorer of the run: whether it agrees with
 * enough human labels on a run of the version graded by the same scorers.
 */
const calibrationSideReasons = async (args: {
  run: EvalRunRow;
  definition: EvalRunDefinition;
  rule: unknown;
}): Promise<VerdictReason[]> => {
  const parsed = parseMinCalibration(args.rule);
  if ('problem' in parsed) return [unreadableCalibrationReason()];
  const keys = externallyGradedKeys(args.definition.scorers);
  if (keys.length === 0) return [];
  const runs = await versionRunCalibrations({
    evalDbId: args.run.evalId,
    agentPublicId: args.run.agentPublicId,
    version: args.run.agentVersion,
    fingerprint: scorerFingerprint({
      scorers: args.definition.scorers,
      deciderVersions: args.run.deciderVersions,
      scorerModels: readScorerModels(args.run.scorerModels),
    }),
  });
  return calibrationReasons({ rule: parsed.rule, keys, runs });
};

/** The reasons the run's recorded evidence adds beyond its items. */
const claimSideReasons = async (args: {
  run: EvalRunRow;
  reading: ClaimReading;
}): Promise<VerdictReason[]> => {
  const definition = readEvalRunDefinition({ run: args.run });
  const evidence = definition?.evidence;
  const reasons: VerdictReason[] =
    evidence?.live === undefined
      ? []
      : await liveSideReasons({ rule: evidence.live, reading: args.reading });
  if (evidence?.max_run_age_days !== undefined) {
    reasons.push(
      ageReason({
        maxDays: evidence.max_run_age_days,
        finishedAt: args.run.finishedAt,
        now: args.reading.now,
      })
    );
  }
  if (definition && evidence?.min_calibration !== undefined) {
    reasons.push(
      ...(await calibrationSideReasons({
        run: args.run,
        definition,
        rule: evidence.min_calibration,
      }))
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
 * A claim as its run settled it, before any rule beyond the run: the pawl
 * judges the stable side by this, so a claim the stable version demonstrated
 * stays required when its traffic stops or its run ages.
 */
export const runClaimOf = (args: {
  evalId: string;
  run: EvalRunRow;
}): VersionClaim => {
  log('runClaimOf: evalId=%s runId=%s', args.evalId, args.run.publicId);
  const { run } = args;
  return {
    eval_id: args.evalId,
    eval_run_id: run.publicId,
    claim: run.claim,
    verdict: isVerdict(run.verdict) ? run.verdict : null,
    verdict_reasons: run.verdictReasons,
    settled_at: run.finishedAt,
  };
};

/**
 * A claim and its verdict: the run's verdict, made worse by every rule the
 * run's recorded evidence declares beyond its items (production, age). The
 * run's own verdict never moves. A run with no verdict gives a claim with no
 * verdict and only the run's reasons: nothing beyond it is read.
 */
export const versionClaimOf = async (args: {
  evalId: string;
  run: EvalRunRow;
  reading: ClaimReading;
}): Promise<VersionClaim> => {
  log('versionClaimOf: eval=%s run=%s', args.evalId, args.run.publicId);
  const settled = runClaimOf(args);
  if (settled.verdict === null) return settled;

  const extra = await claimSideReasons({
    run: args.run,
    reading: args.reading,
  });
  return {
    ...settled,
    verdict: worseOf({ a: settled.verdict, b: worstVerdict(extra) }),
    verdict_reasons: [...(args.run.verdictReasons ?? []), ...extra],
  };
};

/** By code point, not locale: a page boundary must not move with the server's locale. */
const byEvalId = (a: VersionClaim, b: VersionClaim): number => {
  return a.eval_id < b.eval_id ? -1 : 1;
};

/**
 * Every claim the speaking runs carry, by `eval_id`; a run with none holds
 * none. The claims read and the record a promotion writes both come from
 * here, so both are in the same order.
 */
export const versionClaimsOf = async (args: {
  runs: Map<string, EvalRunRow>;
  reading: ClaimReading;
}): Promise<VersionClaim[]> => {
  log('versionClaimsOf: runs=%d', args.runs.size);
  const claimed = [...args.runs].filter(([, run]) => {
    return run.claim !== null;
  });
  const claims = await Promise.all(
    claimed.map(([evalId, run]) => {
      return versionClaimOf({ evalId, run, reading: args.reading });
    })
  );
  return claims.sort(byEvalId);
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
  const claims = await versionClaimsOf({
    runs: await speakingRuns({ agent, version: args.version }),
    reading: claimReading({ agent, version: args.version }),
  });

  return pageOf({
    items: claims,
    limit: args.limit,
    cursor: args.cursor,
    filters: { list: 'claims', agentId: args.agentId, version: args.version },
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
    filters: {
      list: 'promotion-claims',
      agentId: args.agentId,
      version: args.version,
    },
  });
};
