import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  type AgentRef,
  claimReading,
  runClaimOf,
  speakingRun,
  speakingRuns,
  type VersionClaim,
  versionClaimOf,
  versionClaimsOf,
} from './agentVersionClaims';
import { type ActiveRelease, isEvalIdList } from './releaseAssignment';

const log = createDebug('soat:agents');

/**
 * The eval gate on a staged rollout (the agents module doc — Versioning and
 * Staged Rollout).
 *
 * A release may name an eval that has to be green *against the canary version*
 * before promotion. This module owns both halves — what a gate may reference
 * when set, and whether it is satisfied when `promote` is called — so the agent
 * release layer never queries evaluation tables and the two cannot drift.
 *
 * Enforced at exactly one moment: promotion. It does not constrain assignment,
 * and it does not make a run happen — a caller starts the run with
 * `agent_version` pinned to the canary.
 */

/**
 * Validates the `promotion_gate` field's shape, independent of transport.
 * Returns an error message, or null when the input is acceptable.
 */
export const validatePromotionGateInput = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value === '') {
    return 'promotion_gate must be an eval id, or null for an ungated rollout.';
  }
  return null;
};

/**
 * Resolves the gate a release is being set with.
 *
 * The eval must live in the agent's own project **and** test this agent. An
 * eval of some other agent would be trivially satisfiable by a run that says
 * nothing about the config being promoted, so it is rejected as a bad request
 * (`400`) rather than stored and discovered at promotion time.
 */
export const resolvePromotionGate = async (args: {
  agent: AgentRef;
  promotionGate: unknown;
}): Promise<string | null> => {
  const message = validatePromotionGateInput(args.promotionGate);
  if (message) throw new DomainError('VALIDATION_FAILED', message);

  if (args.promotionGate === undefined || args.promotionGate === null) {
    return null;
  }

  // Narrowed by `validatePromotionGateInput`: anything not a non-empty string
  // threw above.
  const gate = String(args.promotionGate);

  const evaluation = await db.Eval.findOne({
    where: { publicId: gate, projectId: args.agent.projectId },
    attributes: ['agentId'],
  });

  if (!evaluation) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `promotion_gate '${gate}' does not reference an eval in this project.`
    );
  }
  if (evaluation.agentId !== args.agent.dbId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `promotion_gate '${gate}' evaluates a different agent than '${args.agent.publicId}'.`
    );
  }

  return gate;
};

/** What a refusal names of the run that speaks for a version. */
const pickRunEvidence = (claim: VersionClaim) => {
  return {
    eval_run_id: claim.eval_run_id,
    claim: claim.claim,
    verdict: claim.verdict,
    verdict_reasons: claim.verdict_reasons,
  };
};

/**
 * Enforces the gate, returning the run row id to record on the promoted
 * version — or null when the release carries no gate.
 *
 * Fails closed: the claim verdict of the speaking run (the run's verdict, made
 * worse by the production and run-age rules it recorded) must read
 * `supported`. No run, a run whose
 * verdict is `insufficient` or `refuted`, a run of another agent or version, a
 * run that recorded no agent or verdict, or a deleted eval is the same
 * `409`. The point of the gate is that promotion is impossible without
 * supporting evidence, so "cannot tell" must never resolve to "allowed".
 */
export const requirePromotionGate = async (args: {
  gate: string | null;
  agent: AgentRef;
  version: number;
}): Promise<number | null> => {
  if (!args.gate) return null;

  log(
    'requirePromotionGate: agent=%s gate=%s version=%d',
    args.agent.publicId,
    args.gate,
    args.version
  );

  const run = await speakingRun({
    evalPublicId: args.gate,
    agent: args.agent,
    version: args.version,
  });
  const claim =
    run &&
    (await versionClaimOf({
      evalId: args.gate,
      run,
      reading: claimReading({ agent: args.agent, version: args.version }),
    }));

  if (!run || claim?.verdict !== 'supported') {
    throw new DomainError(
      'PROMOTION_GATE_UNMET',
      claim
        ? `Promotion gate '${args.gate}' reads ${String(claim.verdict)} for its claim on the newest run against version ${args.version} of agent '${args.agent.publicId}'.`
        : `Promotion gate '${args.gate}' has no completed eval run against version ${args.version} of agent '${args.agent.publicId}'.`,
      {
        promotion_gate: args.gate,
        agent_version: args.version,
        ...(claim && pickRunEvidence(claim)),
      }
    );
  }

  log('requirePromotionGate: satisfied by run=%s', run.publicId);

  return run.id as number;
};

/**
 * Resolves the claims a release gives up: eval ids in the agent's own project,
 * so a typo is a `400` rather than a release of nothing.
 */
export const resolveReleasedClaims = async (args: {
  agent: AgentRef;
  releasedClaims: unknown;
}): Promise<string[]> => {
  if (args.releasedClaims === undefined || args.releasedClaims === null) {
    return [];
  }
  if (!isEvalIdList(args.releasedClaims)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'released_claims must be an array of unique eval ids.'
    );
  }
  const found = await db.Eval.findAll({
    where: { publicId: args.releasedClaims, projectId: args.agent.projectId },
    attributes: ['publicId'],
  });
  const known = new Set(
    found.map((evaluation) => {
      return evaluation.publicId;
    })
  );
  const unknown = args.releasedClaims.find((id) => {
    return !known.has(id);
  });
  if (unknown !== undefined) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `released_claims names '${unknown}', which is not an eval in this project.`
    );
  }
  return args.releasedClaims;
};

/**
 * The pawl on promotion: every claim the stable version's run supports, the
 * canary supports too, unless the release names its eval in `released_claims`.
 * The stable side is judged by its run alone, so a claim it demonstrated stays
 * required when its traffic stops (a canary at 100%) or its run ages. The
 * canary side is judged by its claim verdict, production and run age
 * included, so a canary losing a claim in production is refused as surely as
 * one whose run does. A refuted, insufficient or missing canary claim is the
 * same `409`, so "cannot tell" never resolves to "allowed". Returns the
 * canary's claims, which the promoted version records.
 */
export const requireClaimsHeld = async (args: {
  agent: AgentRef;
  release: ActiveRelease;
}): Promise<VersionClaim[]> => {
  const { stable_version: stable, canary_version: canary } = args.release;
  log(
    'requireClaimsHeld: agent=%s stable=%d canary=%d',
    args.agent.publicId,
    stable,
    canary
  );

  const released = new Set(args.release.released_claims);
  const canaryRuns = await speakingRuns({ agent: args.agent, version: canary });
  const canaryReading = claimReading({ agent: args.agent, version: canary });
  const stableRuns = await speakingRuns({ agent: args.agent, version: stable });
  const held = [...stableRuns]
    .filter(([, run]) => {
      return run.claim !== null;
    })
    .map(([evalId, run]) => {
      return runClaimOf({ evalId, run });
    });
  for (const claim of held) {
    if (claim.verdict !== 'supported' || released.has(claim.eval_id)) continue;
    const run = canaryRuns.get(claim.eval_id);
    const evidence =
      run &&
      (await versionClaimOf({
        evalId: claim.eval_id,
        run,
        reading: canaryReading,
      }));
    if (evidence?.verdict === 'supported') continue;

    throw new DomainError(
      'PROMOTION_CLAIM_UNMET',
      `Version ${stable} of agent '${args.agent.publicId}' supports the claim of eval '${claim.eval_id}'; version ${canary} reads ${evidence ? String(evidence.verdict) : 'no completed run'} on it.`,
      {
        eval_id: claim.eval_id,
        stable_version: stable,
        canary_version: canary,
        eval_run_id: null,
        verdict: null,
        verdict_reasons: null,
        ...(evidence && pickRunEvidence(evidence)),
        claim: claim.claim,
      }
    );
  }
  return versionClaimsOf({ runs: canaryRuns, reading: canaryReading });
};

/**
 * Records what a promotion stood on, on the version it made live: the run that
 * cleared the gate, the claims the promoted canary version held as they read
 * then, and the claims the release gave up.
 *
 * Written after the config apply rather than threaded through it, because the
 * version being stamped is only known then: an apply archives a new version
 * unless the live row already held the canary config, in which case the canary
 * version is what went live. Reading the agent's resulting `version` covers
 * both without predicting which happened.
 *
 * This annotates provenance and never touches an archived `config`, so the
 * configuration a version describes can still never change.
 */
export const recordPromotion = async (args: {
  agentDbId: number;
  version: number;
  evalRunDbId: number | null;
  claims: VersionClaim[];
  releasedClaims: string[];
}): Promise<void> => {
  log(
    'recordPromotion: agentDbId=%d version=%d evalRunDbId=%o',
    args.agentDbId,
    args.version,
    args.evalRunDbId
  );

  await db.AgentVersion.update(
    {
      ...(args.evalRunDbId !== null && { evalRunId: args.evalRunDbId }),
      claims: args.claims,
      releasedClaims: args.releasedClaims,
    },
    { where: { agentId: args.agentDbId, version: args.version } }
  );
};
