import { db } from '../db';
import { DomainError } from '../errors';
import {
  type DeciderQuestions,
  parseDeciderQuestions,
} from './deciderQuestions';
import { deciderQuestionsOf, type DeciderRow } from './deciders';

/** A question set a decision is answered under, stored and parsed. */
export type DeciderQuestionSet = {
  version: number;
  questions: DeciderQuestions;
};

/**
 * The decider's live question set, or the archived one at `version` — what a
 * caller that pinned a version earlier (an eval run) is answered under.
 */
export const deciderQuestionSetAt = async (args: {
  decider: DeciderRow;
  version?: number;
}): Promise<DeciderQuestionSet> => {
  const { decider } = args;
  if (args.version === undefined || args.version === decider.version) {
    return {
      version: decider.version,
      questions: deciderQuestionsOf(decider),
    };
  }
  const archived = await db.DeciderVersion.findOne({
    where: { deciderId: decider.id as number, version: args.version },
  });
  /* istanbul ignore next -- versions are append-only and a pin is always one
     the decider held. */
  if (!archived) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Decider '${decider.publicId}' has no version ${args.version}.`
    );
  }
  const { questions } = archived.config as { questions: unknown };
  return {
    version: args.version,
    questions: parseDeciderQuestions(questions),
  };
};
