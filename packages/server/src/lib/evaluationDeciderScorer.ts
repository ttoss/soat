/**
 * The `decider` scorer's I/O half (the evaluations module doc — Decider
 * scorers): the reference check, the version pin taken at run start, and the
 * decision each item is graded by. The pure contract lives in
 * `evaluationDeciderScorerContract.ts`.
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { createDecision } from './decisions';
import {
  DECIDER_SCORER_TYPE,
  type DeciderScorerDecision,
} from './evaluationDeciderScorerContract';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:evaluations');

/** What an item's decider scorers need from the run grading it. */
export type DeciderScoring = {
  /** Scorer name → pinned decider version; null when the eval has none. */
  versions: Record<string, number> | null;
  evalId: string;
  runId: string;
};

const deciderScorersOf = (scorers: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(scorers)) return [];
  return scorers.filter((raw): raw is Record<string, unknown> => {
    return isPlainObject(raw) && raw.type === DECIDER_SCORER_TYPE;
  });
};

const findDecider = async (args: {
  projectId: number;
  scorer: Record<string, unknown>;
}) => {
  const deciderId = String(args.scorer.decider_id);
  const decider = await db.Decider.findOne({
    where: { publicId: deciderId, projectId: args.projectId },
    attributes: ['version'],
  });
  if (!decider) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `scorer '${String(args.scorer.name)}': decider_id '${deciderId}' does not reference a decider in this project.`
    );
  }
  return decider;
};

/**
 * Resolves every decider scorer's decider within the eval's project, at eval
 * create, eval update and run start — a decider can be deleted in between.
 */
export const validateDeciderScorerRefs = async (args: {
  scorers: unknown;
  projectId: number;
}): Promise<void> => {
  for (const scorer of deciderScorersOf(args.scorers)) {
    await findDecider({ projectId: args.projectId, scorer });
  }
};

/**
 * The decider version each decider scorer grades under for a whole run, so an
 * edit landing mid-run cannot grade half the items under other criteria.
 */
export const pinDeciderVersions = async (args: {
  scorers: unknown;
  projectId: number;
}): Promise<Record<string, number> | null> => {
  const scorers = deciderScorersOf(args.scorers);
  if (scorers.length === 0) return null;
  const versions: Record<string, number> = {};
  for (const scorer of scorers) {
    const decider = await findDecider({ projectId: args.projectId, scorer });
    versions[String(scorer.name)] = decider.version;
  }
  return versions;
};

/**
 * Requests the item's decision and waits for it. Runs with no credential, like
 * every scorer, so a `builtin` pipeline step behind the decider cannot act.
 */
export const runDeciderScorerCall = async (args: {
  projectId: number;
  scorer: Record<string, unknown>;
  input: unknown;
  scoring: DeciderScoring;
  datasetItemId: string;
}): Promise<DeciderScorerDecision> => {
  const name = String(args.scorer.name);
  log('runDeciderScorerCall: scorer=%s run=%s', name, args.scoring.runId);

  const decision = await createDecision({
    projectIds: [args.projectId],
    deciderId: String(args.scorer.decider_id),
    input: args.input,
    wait: true,
    // A scorer added to the eval after the run started has no pin.
    version: args.scoring.versions?.[name],
    metadata: {
      eval_id: args.scoring.evalId,
      eval_run_id: args.scoring.runId,
      dataset_item_id: args.datasetItemId,
    },
  }).catch((error: unknown) => {
    // Admission refusals (paused project, quota, an uncallable tool) write no
    // decision; name the scorer so the item error says which one.
    if (!(error instanceof DomainError)) throw error;
    throw new DomainError(error.code, `scorer '${name}': ${error.message}`);
  });

  if (decision.status !== 'completed' || !Array.isArray(decision.answers)) {
    const error = isPlainObject(decision.error) ? decision.error : {};
    throw new DomainError(
      'VALIDATION_FAILED',
      `scorer '${name}': decision ${decision.id} failed: ${String(error.code)} ${String(error.message)}`
    );
  }
  return {
    decisionId: decision.id,
    answers: decision.answers,
    answersByName: decision.answers_by_name ?? {},
  };
};
