import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';

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

type AgentRef = {
  /** Internal row id — the FK evals and archived versions are matched on. */
  dbId: number;
  publicId: string;
  projectId: number;
};

/** A run is only evidence once it has finished and reported a verdict. */
const COMPLETED_RUN_STATUS = 'completed';

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

/**
 * The run that speaks for one version of this agent: the newest `completed`
 * run of the gate's eval pinned to that version **and recorded against this
 * agent**, whatever its verdict. A newer run that did not support the claim
 * revokes an older one that did, and a run of another agent that happens to
 * share the version number — an eval can be repointed — is not evidence.
 */
const findSpeakingRun = async (args: {
  gate: string;
  agent: AgentRef;
  version: number;
}): Promise<InstanceType<(typeof db)['EvalRun']> | null> => {
  const evaluation = await db.Eval.findOne({
    where: { publicId: args.gate, projectId: args.agent.projectId },
    attributes: ['id'],
  });
  // The eval was validated when the gate was set, so this only fires if it was
  // deleted mid-rollout. An unsatisfiable gate is the safe reading: promotion
  // stays blocked until the release is re-set or aborted.
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
 * Enforces the gate, returning the run row id to record on the promoted
 * version — or null when the release carries no gate.
 *
 * Fails closed: the speaking run must read `supported`. No run, a run whose
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

  const run = await findSpeakingRun({
    gate: args.gate,
    agent: args.agent,
    version: args.version,
  });

  if (run?.verdict !== 'supported') {
    throw new DomainError(
      'PROMOTION_GATE_UNMET',
      run
        ? `Promotion gate '${args.gate}' reads ${String(run.verdict)} on its newest run against version ${args.version} of agent '${args.agent.publicId}'.`
        : `Promotion gate '${args.gate}' has no completed eval run against version ${args.version} of agent '${args.agent.publicId}'.`,
      {
        promotion_gate: args.gate,
        agent_version: args.version,
        ...(run && {
          eval_run_id: run.publicId,
          verdict: run.verdict,
          verdict_reasons: run.verdictReasons,
        }),
      }
    );
  }

  log('requirePromotionGate: satisfied by run=%s', run.publicId);

  return run.id as number;
};

/**
 * Records the run that cleared the gate on the version promotion made live.
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
export const recordPromotionEvalRun = async (args: {
  agentDbId: number;
  version: number;
  evalRunDbId: number | null;
}): Promise<void> => {
  if (args.evalRunDbId === null) return;

  log(
    'recordPromotionEvalRun: agentDbId=%d version=%d evalRunDbId=%d',
    args.agentDbId,
    args.version,
    args.evalRunDbId
  );

  await db.AgentVersion.update(
    { evalRunId: args.evalRunDbId },
    { where: { agentId: args.agentDbId, version: args.version } }
  );
};
