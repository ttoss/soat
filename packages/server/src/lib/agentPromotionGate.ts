import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';

const log = createDebug('soat:agents');

/**
 * The eval gate on a staged rollout (the agents module doc — Versioning and Staged Rollout).
 *
 * A release may name an eval that has to be green *against the canary version*
 * before the canary can be promoted. This module owns both halves of that rule
 * — what a gate may reference when it is set, and whether it is satisfied when
 * `promote` is called — so the agent release layer never queries evaluation
 * tables itself and the two checks cannot drift apart.
 *
 * The gate is enforced at exactly one moment: promotion. It does not constrain
 * assignment (a gated rollout serves traffic like any other), and it does not
 * make a run happen — a caller starts the run, with `agent_version` pinned to
 * the canary, through the evaluations API.
 */

type AgentRef = {
  /** Internal row id — the FK evals and archived versions are matched on. */
  dbId: number;
  publicId: string;
  projectId: number;
};

/** A run is only evidence once it has finished and reported a verdict. */
const PASSING_RUN_STATUS = 'completed';

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
 * The newest passing run of the gate's eval against one agent version, or null.
 *
 * Matching is on the run's pinned `agentVersion`, which is the version every
 * item of that run actually executed against — so a green run of the same eval
 * against a *different* version is not evidence and does not satisfy the gate.
 */
const findPassingGateRun = async (args: {
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
      agentVersion: args.version,
      status: PASSING_RUN_STATUS,
      passed: true,
    },
    order: [['createdAt', 'DESC']],
  });
};

/**
 * Enforces the gate, returning the run row id to record on the promoted
 * version — or null when the release carries no gate.
 *
 * Fails closed: any reason the evidence cannot be produced (no run, no passing
 * run, a run against another version, a deleted eval) is the same `409`. The
 * point of the gate is that promotion is impossible without a green run, so
 * "cannot tell" must never resolve to "allowed".
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

  const run = await findPassingGateRun({
    gate: args.gate,
    agent: args.agent,
    version: args.version,
  });

  if (!run) {
    throw new DomainError(
      'PROMOTION_GATE_UNMET',
      `Promotion gate '${args.gate}' has no passing eval run against version ${args.version} of agent '${args.agent.publicId}'.`,
      { promotion_gate: args.gate, agent_version: args.version }
    );
  }

  log('requirePromotionGate: satisfied by run=%s', run.publicId);

  return run.id as number;
};

/**
 * Records the run that cleared the gate on the version that promotion made
 * live.
 *
 * Written after the config apply rather than threaded through it, because the
 * version being stamped is only known then: an apply archives a new version,
 * unless the live row already held the canary config, in which case the canary
 * version itself is what went live. Reading the agent's resulting `version`
 * covers both without the release layer having to predict which happened.
 *
 * This annotates provenance; it never touches an archived `config`, so the
 * archive stays immutable in the sense that matters — the configuration a
 * version describes can still never change.
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
