import createDebug from 'debug';

import { db } from '../db';
import { agents } from './agentAccessor';
import { agentVersionStore } from './agentVersionSnapshot';
import { type Page, pageOf } from './pagination';
import { isPlainObject } from './plainObject';
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

/**
 * The speaking run of every eval in the agent's project, keyed by eval id.
 * Picked in SQL, one per eval: a version served for months holds hundreds of
 * runs per eval, and only the newest of each is read.
 */
export const speakingRuns = async (args: {
  agent: AgentRef;
  version: number;
}): Promise<Map<string, EvalRunRow>> => {
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

/** A claim as the claims read serves it and a promoted version records it. */
export const versionClaimOf = (args: { evalId: string; run: EvalRunRow }) => {
  return {
    eval_id: args.evalId,
    eval_run_id: args.run.publicId,
    claim: args.run.claim,
    verdict: args.run.verdict,
    verdict_reasons: args.run.verdictReasons,
    settled_at: args.run.finishedAt,
  };
};

export type VersionClaim = ReturnType<typeof versionClaimOf>;

/** Every claim the speaking runs carry; a run with none holds none. */
export const versionClaimsOf = (
  runs: Map<string, EvalRunRow>
): VersionClaim[] => {
  const claims: VersionClaim[] = [];
  for (const [evalId, run] of runs) {
    if (run.claim !== null) claims.push(versionClaimOf({ evalId, run }));
  }
  return claims;
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

  const agent = await db.Agent.findOne({
    where: agents.scopedWhere({
      id: args.agentId,
      projectIds: args.projectIds,
    }),
  });
  if (!agent) throw agents.notFound(args.agentId);
  await agentVersionStore.findVersionRow({
    resource: toResourceRef(agent),
    version: args.version,
  });

  const claims = versionClaimsOf(
    await speakingRuns({
      agent: {
        dbId: agent.id as number,
        publicId: agent.publicId,
        projectId: agent.projectId as number,
      },
      version: args.version,
    })
    // By code point, not locale: a page boundary must not move with the
    // server's locale. Eval ids are unique, so no two compare equal.
  ).sort((a, b) => {
    return a.eval_id < b.eval_id ? -1 : 1;
  });

  return pageOf({
    items: claims,
    limit: args.limit,
    cursor: args.cursor,
    filters: { agentId: args.agentId, version: args.version },
  });
};
